// ig-pubs-scraper.mjs
// Scrapes recent posts from Cheltenham pub Instagram accounts using injected cookies.
// Runs in GitHub Actions (Ubuntu, full Playwright deps). Weekly cadence.
// Adds posts with a date in the caption as new events.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { homedir } from 'os';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EVENTS_PATH = path.join(REPO_ROOT, 'events.json');
const IMAGES_DIR = path.join(REPO_ROOT, 'images', 'ig-events');

const ACCOUNTS = [
  { handle: 'theploughprestbury',       venue: 'The Plough Prestbury' },
  { handle: 'sandfordalehouse',          venue: 'Sandford Park Alehouse' },
  { handle: 'frogfiddlecheltenham',      venue: 'Frog & Fiddle' },
  { handle: 'thestrandgl50',             venue: 'The Strand' },
  { handle: 'bottleofsaucecheltenham',   venue: 'Bottle of Sauce' },
  { handle: 'exmoutharmscheltenham',     venue: 'Exmouth Arms' },
  { handle: 'royaloakprestbury',         venue: 'Royal Oak Prestbury' },
  { handle: 'thevinecheltenham',         venue: 'The Vine' },
  { handle: 'airsandgracescheltenham',   venue: 'Airs & Graces' },
  { handle: '33therumbar',               venue: '33 The Rum Bar' },
  { handle: 'johngordons',               venue: 'John Gordon\'s' },
];

const MONTH_MAP = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const SKIP_KEYWORDS = ['follow','repost','throwback','tbt','happy birthday','congratulations','hiring','vacancy','winner','competition'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

function convertCookies(raw) {
  const sameSiteMap = { no_restriction:'None', lax:'Lax', strict:'Strict', unspecified:'None' };
  return raw.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: c.session ? -1 : Math.floor(c.expirationDate || -1),
    httpOnly: c.httpOnly || false, secure: c.secure || false,
    sameSite: sameSiteMap[c.sameSite] || 'None',
  }));
}

function looksLikeEvent(caption) {
  if (!caption) return false;
  const lower = caption.toLowerCase();
  if (SKIP_KEYWORDS.some(k => lower.includes(k))) return false;
  return /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(caption)
    || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(caption);
}

function extractDate(caption) {
  const now = new Date();
  const patterns = [
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i,
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
  ];
  for (const p of patterns) {
    const m = caption.match(p);
    if (!m) continue;
    let day, monthStr;
    if (isNaN(m[1])) { monthStr = m[1]; day = parseInt(m[2]); }
    else { day = parseInt(m[1]); monthStr = m[2]; }
    const month = MONTH_MAP[monthStr.toLowerCase()];
    if (!month) continue;
    let year = now.getFullYear();
    const d = new Date(year, month - 1, day);
    if (d < new Date(now - 7 * 86400000)) year++; // past > 1 week → next year
    return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  return null;
}

function extractTime(caption) {
  const m = caption.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let h = parseInt(m[1]), mn = parseInt(m[2] || '0');
  if (m[3].toLowerCase() === 'pm' && h < 12) h += 12;
  if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}`;
}

function guessTitle(caption, venue) {
  const lines = caption.split('\n').map(l => l.trim().replace(/^[#@🎉🎶🍺🍻🎸🎤✨💥🔥❤️]+/, '').trim()).filter(l => l.length > 4);
  if (lines[0] && lines[0].length < 80) return lines[0];
  return `${venue} Event`;
}

async function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { file.close(); reject(err); });
  });
}

async function scrapeAccount(page, account, existingUrls) {
  const { handle, venue } = account;
  const profileUrl = `https://www.instagram.com/${handle}/`;
  console.log(`\n→ ${handle}`);

  await page.goto(profileUrl, { waitUntil: 'load', timeout: 30000 });
  await jitter(3000, 5000);

  // Check if we're actually on the profile (not login wall)
  const title = await page.title();
  console.log(`  title: ${title.slice(0, 60)}`);
  if (title.toLowerCase().includes('log in') || title.toLowerCase().includes('login')) {
    console.log('  ⚠ Login wall — skipping');
    return [];
  }

  // Scroll to load grid
  await page.mouse.wheel(0, 500);
  await jitter(1500, 2500);

  // Extract post links from the grid
  const postLinks = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="/p/"]')];
    return [...new Set(anchors.map(a => a.href).filter(h => h.includes('/p/')))].slice(0, 12);
  });

  console.log(`  posts found: ${postLinks.length}`);

  const newEvents = [];

  for (const postUrl of postLinks) {
    // Skip already-known posts
    const clean = postUrl.split('?')[0].replace(/\/$/, '') + '/';
    if (existingUrls.has(clean)) continue;

    await jitter(3000, 6000);

    try {
      await page.goto(postUrl, { waitUntil: 'load', timeout: 30000 });
      await jitter(2000, 4000);

      // Extract caption and image
      const data = await page.evaluate(() => {
        const caption = document.querySelector('h1, [data-testid="post-comment-root"] span, article span')?.innerText
          || document.querySelector('meta[name="description"]')?.content
          || '';
        const img = document.querySelector('article img[src*="cdninstagram"], article img[src*="instagram"]')?.src || null;
        return { caption, img };
      });

      if (!data.caption || !looksLikeEvent(data.caption)) continue;

      const date = extractDate(data.caption);
      if (!date) continue;

      const time = extractTime(data.caption);
      const name = guessTitle(data.caption, venue);

      console.log(`  + ${name} | ${date}${time ? ' ' + time : ''}`);

      newEvents.push({
        postUrl: clean,
        name, date, time, venue,
        caption: data.caption,
        image: data.img,
      });

      existingUrls.add(clean);
    } catch(err) {
      console.log(`  error on ${postUrl.slice(-20)}: ${err.message.slice(0, 60)}`);
    }
  }

  return newEvents;
}

async function main() {
  const cookiesRaw = JSON.parse(process.env.IG_COOKIES || readFileSync(`${homedir()}/.config/instagram/cookies.json`, 'utf8'));
  const cookies = convertCookies(cookiesRaw);

  mkdirSync(IMAGES_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await context.addCookies(cookies);

  const page = await context.newPage();

  // Land on Instagram homepage first
  console.log('Landing on Instagram...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'load', timeout: 30000 });
  await jitter(3000, 5000);

  const events = JSON.parse(readFileSync(EVENTS_PATH, 'utf8'));
  const existingUrls = new Set(events.map(e => e.url).filter(Boolean));

  const allNew = [];

  for (const account of ACCOUNTS) {
    try {
      const found = await scrapeAccount(page, account, existingUrls);
      allNew.push(...found);
    } catch(err) {
      console.log(`  fatal error on ${account.handle}: ${err.message.slice(0, 80)}`);
    }
    await jitter(5000, 10000); // generous pause between accounts
  }

  await browser.close();

  console.log(`\n=== SUMMARY ===`);
  console.log(`New events found: ${allNew.length}`);

  if (allNew.length === 0) { console.log('Nothing to add.'); return; }

  // Download images and build event objects
  const toAdd = [];
  for (const ev of allNew) {
    let imagePath = null;
    if (ev.image) {
      const slug = ev.postUrl.match(/\/p\/([^/]+)/)?.[1] || Date.now();
      const dest = path.join(IMAGES_DIR, `${slug}.jpg`);
      try {
        await downloadImage(ev.image, dest);
        imagePath = `https://raw.githubusercontent.com/timholtom/cheltenham-events/main/images/ig-events/${slug}.jpg`;
      } catch(e) { console.log(`  img download failed: ${e.message}`); }
    }

    toAdd.push({
      name: ev.name,
      date: ev.date,
      ...(ev.time && { time: ev.time }),
      venue: ev.venue,
      url: ev.postUrl,
      source: 'instagram-pubs',
      categories: ['community'],
      ...(imagePath && { image: imagePath }),
      description: ev.caption.slice(0, 300).replace(/\n+/g, ' ').trim(),
      city: 'Cheltenham',
    });
  }

  const merged = [...events, ...toAdd].sort((a, b) => (a.date||'9999') > (b.date||'9999') ? 1 : -1);
  writeFileSync(EVENTS_PATH, JSON.stringify(merged, null, 2));
  console.log(`Added ${toAdd.length} events. Total: ${merged.length}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
