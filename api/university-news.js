// Bitcoin University is the user's own beehiiv newsletter.
//
// /feed on this custom domain always returns the site's client-rendered
// SPA shell (a 200 response starting with "<!DOCTYPE html>"), no matter
// what User-Agent/Accept headers are sent — confirmed by trying a Chrome
// UA, a Googlebot UA, and Google's FeedFetcher UA, all with an RSS-only
// Accept header, and getting byte-identical HTML back every time. So
// there's no real feed to fetch here; the actual post list only exists in
// the JS-rendered homepage.
//
// Workaround: render the homepage like a browser via the r.jina.ai reader
// proxy (same approach already used elsewhere in this app for
// farside.co.uk and companiesmarketcap.com) and scrape post links out of
// the resulting markdown. This has been confirmed working end-to-end from
// the deployed function (it returned the real page title), the remaining
// issue is just matching the actual link structure r.jina.ai produces.
const HOME_URL = "https://bitcoin-university.beehiiv.com/";
const READER_URL = "https://r.jina.ai/" + HOME_URL;

// Each post on the homepage renders as ONE outer markdown link whose text
// contains a cover image (`![Image N: title](imgUrl)`), a nested category
// tag link, a "### title" heading, optionally a one-line summary, a byline
// ("<name> 비트코인 저널리스트"), a "•" separator, and a date — with the
// whole thing closing as `](postUrl)`. Confirmed against a real captured
// response (see api/university-news debug output from 2026-07-18): the
// image's alt text duplicates the title, which is the most reliable way
// to pull it out, since the "###" heading is nested behind other bracketed
// links and can't be matched by looking forward from the post URL. Every
// post also repeats later on the page (under "Featured") — only the first
// (richest) occurrence of each URL is kept.
const POST_URL_RE = /\]\((https:\/\/bitcoin-university\.beehiiv\.com\/p\/[^)\s]+)\)/g;
const IMAGE_RE = /!\[Image\s*\d+:\s*([^\]]+)\]/g;
const DATE_RE = /([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})|(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/;
const BYLINE_RE = /[가-힣]{2,5}\s*비트코인\s*저널리스트/;

function parseDate(text) {
  const m = text.match(DATE_RE);
  if (!m) return null;
  if (m[1]) {
    const t = Date.parse(m[1]);
    return Number.isNaN(t) ? null : t;
  }
  const t = new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4])).getTime();
  return Number.isNaN(t) ? null : t;
}

function parsePostsFromMarkdown(markdown) {
  const seen = new Set();
  const posts = [];
  let m;
  while ((m = POST_URL_RE.exec(markdown)) !== null) {
    const url = m[1].trim();
    if (seen.has(url)) continue;

    // Walk backward from the post URL to the nearest preceding cover
    // image — anchoring on the real post URL (rather than scanning
    // forward from every image) avoids swallowing unrelated cards, like
    // the site logo, which is also "![Image N: Logo]" but links to the
    // homepage rather than a /p/ URL.
    const windowStart = Math.max(0, m.index - 700);
    const before = markdown.slice(windowStart, m.index);
    IMAGE_RE.lastIndex = 0;
    let lastImageMatch = null;
    let im;
    while ((im = IMAGE_RE.exec(before)) !== null) lastImageMatch = im;
    if (!lastImageMatch) continue; // not actually a post card (e.g. a stray nav link)
    const title = lastImageMatch[1].trim();
    if (!title || title === "Logo") continue;

    seen.add(url);
    const block = before.slice(lastImageMatch.index) + m[0];

    let summary = null;
    const headingIdx = block.indexOf("###");
    if (headingIdx !== -1) {
      const afterHeading = block.slice(headingIdx + 3).trim();
      const withoutTitle = afterHeading.startsWith(title) ? afterHeading.slice(title.length).trim() : afterHeading;
      const bylineMatch = withoutTitle.match(BYLINE_RE);
      const cutIdx = bylineMatch ? bylineMatch.index : withoutTitle.search(/•|[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}/);
      const candidate = (cutIdx === -1 ? withoutTitle : withoutTitle.slice(0, cutIdx)).trim();
      if (candidate && candidate.length <= 200) summary = candidate;
    }

    posts.push({ title, url, imageUrl: null, summary, publishedAt: parseDate(block) });
  }
  posts.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return posts.slice(0, 30);
}

function snippet(text, len) {
  return JSON.stringify((text || "").replace(/\s+/g, " ").trim().slice(0, len || 160));
}

// Bumped whenever the parsing logic changes — included in every response
// (success or error) so it's immediately obvious from the API output
// alone whether a given deployment is actually running this version, as
// opposed to the confusion staying up in the air.
const PARSER_VERSION = "2026-07-19-full-article-archive";

// ---- Full article text (for ask.html's AI to draw on) ----
// Same r.jina.ai reader technique as the homepage, but pointed at each
// post's own URL. Every response — for the homepage AND for a single
// post — starts with the same "Title: X | Y\nURL Source: ...\nPublished
// Time: ...\nMarkdown Content:\n" preamble, so the real body is
// everything after "Markdown Content:". The nav/logo boilerplate at the
// top of that body is stripped by cutting at the post's own title (which
// reappears once the real article content starts) and dropping short
// nav-style links.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ARCHIVE_KEY = "university-articles-archive";
// Backfilling full text is only ever done for posts not already
// archived, and only one per invocation, so a slow/hanging reader
// request never makes a normal page load noticeably slower than before.
const MAX_BACKFILL_PER_CALL = 1;
// Kept short deliberately: after the just-resolved function-count outage,
// changing vercel.json's function maxDuration felt like an unnecessary
// new risk. A tight per-fetch timeout keeps this comfortably inside the
// default ~10s execution budget instead — an occasional skipped backfill
// (retried on the next call) is a fine trade-off for not touching deploy
// config again right now.
const FETCH_TIMEOUT_MS = 5000;

function redisConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisGetArchive() {
  const res = await fetch(`${REDIS_URL}/get/${ARCHIVE_KEY}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`redis GET failed: ${res.status}`);
  const data = await res.json();
  if (!data.result) return {};
  try {
    const parsed = JSON.parse(data.result);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function redisSetArchive(archive) {
  await fetch(`${REDIS_URL}/set/${ARCHIVE_KEY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "text/plain" },
    body: JSON.stringify(archive),
  });
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractArticleBody(markdown, title) {
  const marker = "Markdown Content:";
  const idx = markdown.indexOf(marker);
  let body = idx !== -1 ? markdown.slice(idx + marker.length) : markdown;

  body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // drop images (cover art, logos)

  // The article's own title reappears once past the nav/logo boilerplate
  // — cut everything before that so the extracted text starts at the
  // real content rather than "Search / Log in / Subscribe / ...".
  const titleIdx = title ? body.indexOf(title) : -1;
  if (titleIdx !== -1) body = body.slice(titleIdx + title.length);

  body = body.replace(/\[[^\]]{1,14}\]\([^)]*\)/g, " "); // short nav-style links
  body = body.replace(/\s+/g, " ").trim();
  return body;
}

async function backfillArticleBodies(posts) {
  if (!redisConfigured()) return { archive: {}, updated: false };
  let archive;
  try {
    archive = await redisGetArchive();
  } catch {
    return { archive: {}, updated: false };
  }

  const missing = posts.filter((p) => !archive[p.url]).slice(0, MAX_BACKFILL_PER_CALL);
  if (!missing.length) return { archive, updated: false };

  let updated = false;
  for (const post of missing) {
    try {
      const r = await fetchWithTimeout("https://r.jina.ai/" + post.url, FETCH_TIMEOUT_MS);
      if (!r.ok) continue;
      const markdown = await r.text();
      const body = extractArticleBody(markdown, post.title);
      if (body.length < 100) continue; // extraction likely failed — try again next call
      archive[post.url] = {
        title: post.title,
        publishedAt: post.publishedAt,
        body: body.slice(0, 4000),
        fetchedAt: new Date().toISOString(),
      };
      updated = true;
    } catch {
      // timed out or network error — leave unarchived, retried on a future call
    }
  }

  if (updated) await redisSetArchive(archive).catch(() => {});
  return { archive, updated };
}

export default async function handler(req, res) {
  try {
    const r = await fetch(READER_URL);
    const markdown = await r.text();
    if (!r.ok) throw new Error(`reader upstream responded ${r.status}, got ${snippet(markdown)}`);

    // ?debug=1 dumps the raw rendered markdown so the link/date structure
    // can be inspected directly instead of guessing from a short snippet.
    if (req.query && req.query.debug) {
      res.status(200).json({ parserVersion: PARSER_VERSION, markdown });
      return;
    }

    const posts = parsePostsFromMarkdown(markdown);
    if (!posts.length) {
      throw new Error(`no post links found in rendered homepage, got ${snippet(markdown, 4000)}`);
    }

    const { archive } = await backfillArticleBodies(posts);
    const fullArticles = Object.values(archive).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=900");
    res.status(200).json({ parserVersion: PARSER_VERSION, fetchedAt: new Date().toISOString(), posts, fullArticles });
  } catch (e) {
    res.status(502).json({ parserVersion: PARSER_VERSION, error: "Bitcoin University feed fetch failed: " + e.message });
  }
}
