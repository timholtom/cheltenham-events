// fb-sandford-scraper.mjs
// Scrapes Sandford Park Alehouse Facebook events with human-like behaviour.
// Designed to run in GitHub Actions (Ubuntu, full Playwright deps).
// Cookies injected from FB_COOKIES env var (JSON string).

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createWriteStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EVENTS_PATH = path.join(REPO_ROOT, 'events.json');
const IMAGES_DIR = path.join(REPO_ROOT, 'images', 'fb-events');

const FB_PAGE = 'https://www.facebook.com/sanfordpark.house/events';
const KNOWN_EVENTS = [
  '1467306618409139',
  '2754341734943409',
  '1768863420736072',
  '2808727212801642',
  '936739885352905',
  '924609546891972',
  '2126574084846423',
  '735893079459837',
];

// Convert EditThisCookie / raw JSON format → Playwright format
function convertCookies(raw) {
  const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'None' };
  return raw.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.session ? -1 : Math.floor(c.expirationDate || -1),
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: sameSiteMap[c.sameSite] || 'None',
  }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

async function humanScroll(page, times = 3) {
  for (let i = 0; i < times; i++) {
    const dist = 250 + Math.floor(Math.random() * 300);
    await page.mouse.wheel(0, dist);
    await jitter(900, 2200);
  }
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
    }).on('error', err => {
      file.close();
      reject(err);
    });
  });
}

async function scrapeEventPage(page, eventId) {
  const url = `https://www.facebook.com/events/${eventId}/`;
  console.log(`  → ${url}`);

  // Intercept image responses — track the largest one fetched (likely the cover)
  const interceptedImages = [];
  const responseHandler = async (response) => {
    const resUrl = response.url();
    const ct = response.headers()['content-type'] || '';
    if (ct.startsWith('image/') && (resUrl.includes('scontent') || resUrl.includes('fbcdn'))) {
      try {
        const buf = await response.body();
        if (buf.length > 40000) { // >40KB = real photo, not icon
          interceptedImages.push({ url: resUrl, size: buf.length });
        }
      } catch(e) {}
    }
  };
  page.on('response', responseHandler);

  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await jitter(3000, 5000);
  await humanScroll(page, 2);
  await jitter(2000, 3000);

  page.off('response', responseHandler);

  const html = await page.content();
  const pageTitle = await page.title();

  // og:image from HTML
  const ogImg = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);

  // Pick largest intercepted image as cover
  interceptedImages.sort((a, b) => b.size - a.size);
  const bestIntercepted = interceptedImages[0]?.url || null;

  console.log(`    og:image: ${!!ogImg}, intercepted: ${interceptedImages.length} (largest: ${interceptedImages[0]?.size || 0} bytes)`);

  const imageUrl = ogImg
    ? ogImg[1].replace(/&amp;/g, '&')
    : bestIntercepted;

  return {
    id: eventId,
    url,
    image: imageUrl,
    title: ogTitle ? ogTitle[1] : pageTitle?.replace(/^\(\d+\)\s*/, '').replace(' | Facebook', '').trim() || null,
  };
}

async function scrapeEventsPage(page) {
  console.log('Checking events page for new events...');
  await page.goto(FB_PAGE, { waitUntil: 'load', timeout: 45000 });
  await jitter(3000, 5000);
  await humanScroll(page, 4);

  const html = await page.content();

  // Extract event IDs from the page
  const matches = [...html.matchAll(/\/events\/(\d{10,})/g)];
  const ids = [...new Set(matches.map(m => m[1]))];
  const newIds = ids.filter(id => !KNOWN_EVENTS.includes(id));

  console.log(`Found ${ids.length} event IDs, ${newIds.length} new`);
  return newIds;
}

async function main() {
  const cookiesRaw = process.env.FB_COOKIES;
  if (!cookiesRaw) {
    console.error('FB_COOKIES env var not set');
    process.exit(1);
  }

  const cookies = convertCookies(JSON.parse(cookiesRaw));

  mkdirSync(IMAGES_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    // Don't reveal automation
    extraHTTPHeaders: {
      'Accept-Language': 'en-GB,en;q=0.9',
    },
  });

  // Mask webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await context.addCookies(cookies);

  const page = await context.newPage();

  // Land on FB homepage first — looks natural
  console.log('Landing on Facebook homepage...');
  await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
  await jitter(3000, 5500);

  // Brief idle — simulate reading the feed
  await humanScroll(page, 2);
  await jitter(2000, 4000);

  // Check if logged in
  const html = await page.content();
  const loggedIn = !html.includes('"loginType"') && (html.includes('"USER_ID"') || html.includes('"user_id"') || html.includes('c_user'));
  console.log('Login status:', loggedIn ? 'looks good' : 'uncertain — proceeding anyway');

  // Check events page for new events
  const newEventIds = await scrapeEventsPage(page);

  // Scrape cover images for all known + new events
  const allIds = [...KNOWN_EVENTS, ...newEventIds];
  const results = {};

  for (const id of allIds) {
    await jitter(4000, 8000); // natural pause between event pages
    try {
      const data = await scrapeEventPage(page, id);
      results[id] = data;
      console.log(`  title: ${data.title || 'unknown'}`);
      console.log(`  image: ${data.image ? 'found' : 'none'}`);
    } catch (err) {
      console.log(`  error: ${err.message}`);
      results[id] = { id, url: `https://www.facebook.com/events/${id}/`, error: err.message };
    }
  }

  await browser.close();

  // Download images and update events.json
  const events = JSON.parse(readFileSync(EVENTS_PATH, 'utf8'));
  let changed = 0;

  for (const [id, data] of Object.entries(results)) {
    if (!data.image) continue;

    const imgPath = path.join(IMAGES_DIR, `event-${id}.jpg`);
    const imgRelative = `images/fb-events/event-${id}.jpg`;
    const imgGithubUrl = `https://raw.githubusercontent.com/timholtom/cheltenham-events/main/${imgRelative}`;

    // Download image if not already saved
    if (!existsSync(imgPath)) {
      try {
        console.log(`Downloading image for ${id}...`);
        await downloadImage(data.image, imgPath);
        console.log(`  saved to ${imgRelative}`);
      } catch (err) {
        console.log(`  download failed: ${err.message}`);
        continue;
      }
    }

    // Update events.json for matching event
    const event = events.find(e => e.url && e.url.includes(id));
    if (event && event.image !== imgGithubUrl) {
      event.image = imgGithubUrl;
      changed++;
      console.log(`Updated image for: ${event.name}`);
    }

    // If new event not in events.json, log for manual review
    if (!events.find(e => e.url && e.url.includes(id))) {
      console.log(`NEW EVENT FOUND: ${data.title || id} — needs manual add`);
      console.log(`  url: https://www.facebook.com/events/${id}/`);
    }
  }

  if (changed > 0) {
    writeFileSync(EVENTS_PATH, JSON.stringify(events, null, 2));
    console.log(`\nUpdated ${changed} events in events.json`);
  } else {
    console.log('\nNo changes needed');
  }

  // Output summary for GitHub Actions
  console.log('\n=== SUMMARY ===');
  console.log(`Known events processed: ${KNOWN_EVENTS.length}`);
  console.log(`New events found: ${newEventIds.length}`);
  console.log(`Images downloaded: ${changed}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
