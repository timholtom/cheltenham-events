// fb-sandford-scraper.mjs
// Scrapes Facebook events from Cheltenham venues using injected cookies.
// Runs in GitHub Actions (Ubuntu, full Playwright deps). Weekly cadence.
// Handles: Sandford Park Alehouse, John Gordon's (+ any future venues)

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

// Venues to scrape — add new ones here
const VENUES = [
  {
    handle: 'sanfordpark.house',
    name: 'Sandford Park Alehouse',
    city: 'Cheltenham',
    categories: ['food-drink', 'community'],
    // Known event IDs — skip re-downloading images for these, just refresh if missing
    knownIds: [
      '1467306618409139',
      '2754341734943409',
      '1768863420736072',
      '2808727212801642',
      '936739885352905',
      '924609546891972',
      '2126574084846423',
      '735893079459837',
    ],
  },
  {
    handle: 'JohnGordonsCheltenham',
    name: "John Gordon's",
    city: 'Cheltenham',
    categories: ['nightlife', 'community'],
    knownIds: [],
  },
];

function convertCookies(raw) {
  const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'None' };
  return raw.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: c.session ? -1 : Math.floor(c.expirationDate || -1),
    httpOnly: c.httpOnly || false, secure: c.secure || false,
    sameSite: sameSiteMap[c.sameSite] || 'None',
  }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

async function humanScroll(page, times = 3) {
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, 250 + Math.floor(Math.random() * 300));
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
    }).on('error', err => { file.close(); reject(err); });
  });
}

async function scrapeEventsPage(page, venue) {
  const url = `https://www.facebook.com/${venue.handle}/events`;
  console.log(`\n→ ${venue.name} (${url})`);

  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await jitter(3000, 5000);
  await humanScroll(page, 4);
  await jitter(2000, 3000);

  const html = await page.content();
  const matches = [...html.matchAll(/\/events\/(\d{10,})/g)];
  const ids = [...new Set(matches.map(m => m[1]))];
  const newIds = ids.filter(id => !venue.knownIds.includes(id));

  console.log(`  Event IDs found: ${ids.length} total, ${newIds.length} new`);
  return { allIds: ids, newIds };
}

async function scrapeEventPage(page, eventId) {
  const url = `https://www.facebook.com/events/${eventId}/`;
  console.log(`  → event ${eventId}`);

  const interceptedImages = [];
  const responseHandler = async (response) => {
    const resUrl = response.url();
    const ct = response.headers()['content-type'] || '';
    if (ct.startsWith('image/') && (resUrl.includes('scontent') || resUrl.includes('fbcdn'))) {
      try {
        const buf = await response.body();
        if (buf.length > 40000) interceptedImages.push({ url: resUrl, size: buf.length });
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

  const ogImg = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
  const ogDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i);

  // Extract date from JSON-LD or meta
  const startDate = html.match(/"startDate"\s*:\s*"([^"]+)"/)?.[1];
  const endDate = html.match(/"endDate"\s*:\s*"([^"]+)"/)?.[1];

  interceptedImages.sort((a, b) => b.size - a.size);
  const imageUrl = ogImg
    ? ogImg[1].replace(/&amp;/g, '&')
    : interceptedImages[0]?.url || null;

  const title = ogTitle
    ? ogTitle[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'")
    : pageTitle?.replace(/^\(\d+\)\s*/, '').replace(' | Facebook', '').trim() || null;

  const description = ogDesc
    ? ogDesc[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'").slice(0, 300)
    : null;

  console.log(`    title: ${title?.slice(0,50) || 'unknown'}`);
  console.log(`    date: ${startDate || 'unknown'} | image: ${imageUrl ? 'yes' : 'no'}`);

  return { id: eventId, url, image: imageUrl, title, description, startDate, endDate };
}

function parseISODate(isoStr) {
  if (!isoStr) return null;
  return isoStr.slice(0, 10);
}

function parseISOTime(isoStr) {
  if (!isoStr) return null;
  const m = isoStr.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

async function main() {
  const cookiesRaw = process.env.FB_COOKIES;
  if (!cookiesRaw) { console.error('FB_COOKIES env var not set'); process.exit(1); }

  const cookies = convertCookies(JSON.parse(cookiesRaw));
  mkdirSync(IMAGES_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-features=IsolateOrigins,site-per-process'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await context.addCookies(cookies);

  const page = await context.newPage();

  console.log('Landing on Facebook homepage...');
  await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
  await jitter(3000, 5500);
  await humanScroll(page, 2);
  await jitter(2000, 4000);

  const events = JSON.parse(readFileSync(EVENTS_PATH, 'utf8'));
  const existingUrls = new Set(events.map(e => e.url).filter(Boolean));
  const existingKeys = new Set(events.map(e => `${e.name?.toLowerCase()}|${e.date}`));

  let totalChanged = 0;
  let totalAdded = 0;

  for (const venue of VENUES) {
    await jitter(4000, 7000);

    const { allIds, newIds } = await scrapeEventsPage(page, venue);

    // Process: known IDs (for image refresh) + new IDs (for adding)
    const idsToProcess = [...new Set([...venue.knownIds, ...newIds])];

    for (const id of idsToProcess) {
      await jitter(4000, 8000);

      let data;
      try {
        data = await scrapeEventPage(page, id);
      } catch(err) {
        console.log(`  error scraping event ${id}: ${err.message}`);
        continue;
      }

      const eventUrl = `https://www.facebook.com/events/${id}/`;
      const imgPath = path.join(IMAGES_DIR, `event-${id}.jpg`);
      const imgGithubUrl = `https://raw.githubusercontent.com/timholtom/cheltenham-events/main/images/fb-events/event-${id}.jpg`;

      // Download image if we have one and it's not saved yet
      if (data.image && !existsSync(imgPath)) {
        try {
          console.log(`  downloading image for ${id}...`);
          await downloadImage(data.image, imgPath);
        } catch(err) {
          console.log(`  image download failed: ${err.message}`);
        }
      }

      const existing = events.find(e => e.url && e.url.includes(id));

      if (existing) {
        // Update image if we now have it
        if (existsSync(imgPath) && existing.image !== imgGithubUrl) {
          existing.image = imgGithubUrl;
          totalChanged++;
          console.log(`  ✓ updated image: ${existing.name}`);
        }
      } else if (newIds.includes(id)) {
        // New event — add it with dupe check
        const date = parseISODate(data.startDate);
        const name = data.title || `${venue.name} Event`;
        const dupeKey = `${name.toLowerCase()}|${date}`;

        if (!date) { console.log(`  ⚠ no date for ${id}, skipping`); continue; }
        if (existingUrls.has(eventUrl)) { console.log(`  ⚠ URL already exists, skipping`); continue; }
        if (existingKeys.has(dupeKey)) { console.log(`  ⚠ dupe by name+date: ${name} | ${date}`); continue; }

        const newEvent = {
          name,
          date,
          ...(parseISOTime(data.startDate) && { time: parseISOTime(data.startDate) }),
          venue: venue.name,
          url: eventUrl,
          ...(existsSync(imgPath) && { image: imgGithubUrl }),
          categories: venue.categories,
          ...(data.description && { description: data.description }),
          source: 'facebook-scrape',
          city: venue.city,
        };

        events.push(newEvent);
        existingUrls.add(eventUrl);
        existingKeys.add(dupeKey);
        totalAdded++;
        console.log(`  + added: ${name} | ${date}`);
      }
    }
  }

  await browser.close();

  if (totalChanged > 0 || totalAdded > 0) {
    const sorted = events.sort((a,b) => (a.date||'9999') > (b.date||'9999') ? 1 : -1);
    writeFileSync(EVENTS_PATH, JSON.stringify(sorted, null, 2));
    console.log(`\nUpdated ${totalChanged} images, added ${totalAdded} new events. Total: ${events.length}`);
  } else {
    console.log('\nNo changes needed.');
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Images updated: ${totalChanged}`);
  console.log(`New events added: ${totalAdded}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
