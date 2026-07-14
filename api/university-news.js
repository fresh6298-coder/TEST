// Bitcoin University is the user's own beehiiv newsletter.
//
// A plain fetch of /feed with a Chrome desktop User-Agent returns the
// site's client-rendered SPA shell (confirmed from the deployed function's
// raw error: a 200 response starting with "<!DOCTYPE html>", with no
// <link rel="alternate" type="application/rss+xml"> anywhere in it either).
// But other tools (e.g. Gemini, when explicitly told this is an RSS feed)
// have read real <item>/<title> content from the exact same URL. The
// likely explanation: beehiiv (or a CDN/edge worker in front of it) is
// doing content negotiation or user-agent sniffing — serving XML only to
// requests that look like a feed reader or a known crawler, and falling
// back to the HTML app shell for everything else. So we try a few
// feed-reader-shaped requests before giving up on RSS entirely.
const FEED_URL = "https://bitcoin-university.beehiiv.com/feed";

// Fallback if none of those work: render the homepage like a browser via
// the r.jina.ai reader proxy (same workaround already used elsewhere in
// this app for farside.co.uk and companiesmarketcap.com) and scrape post
// links out of the resulting markdown.
const HOME_URL = "https://bitcoin-university.beehiiv.com/";
const READER_URL = "https://r.jina.ai/" + HOME_URL;

const FETCH_ATTEMPTS = [
  {
    label: "rss-accept+googlebot-ua",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  },
  {
    label: "rss-accept+feedfetcher-ua",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; FeedFetcher-Google; +http://www.google.com/feedfetcher.html)",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  },
  {
    label: "rss-accept-only+chrome-ua",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  },
];

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(m[1]) : null;
}

function extractImage(xml) {
  let m =
    xml.match(/<media:content[^>]*url="([^"]+)"/i) ||
    xml.match(/<media:thumbnail[^>]*url="([^"]+)"/i) ||
    xml.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/i);
  if (m) return m[1];
  m = xml.match(/<img[^>]*src="([^"]+)"/i);
  return m ? m[1] : null;
}

function looksLikeXml(text) {
  return /^\s*(<\?xml|<rss[\s>]|<feed[\s>])/i.test(text);
}

function parsePostsFromXml(xml) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link") || extractTag(block, "guid");
    const pubDateStr = extractTag(block, "pubDate") || extractTag(block, "dc:date");
    const description =
      extractTag(block, "content:encoded") || extractTag(block, "description") || "";
    const publishedAt = pubDateStr ? Date.parse(pubDateStr) : NaN;

    if (title && link) {
      items.push({
        title,
        url: link.trim(),
        imageUrl: extractImage(block),
        summary: description.replace(/<[^>]*>/g, "").trim().slice(0, 280) || null,
        publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
      });
    }
  }
  return items;
}

// beehiiv's default post permalink shape.
const POST_LINK_RE = /\[([^\]]*)\]\((https:\/\/bitcoin-university\.beehiiv\.com\/p\/[^)\s]+)\)/g;

// Best-effort date near a link's position in the rendered markdown — dates
// on a beehiiv homepage usually sit right next to the title, but aren't
// part of the markdown link syntax itself, so this can't be exact.
const DATE_RE = /([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})|(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/;

function nearbyDate(markdown, fromIndex) {
  const window = markdown.slice(fromIndex, fromIndex + 300);
  const m = window.match(DATE_RE);
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
  while ((m = POST_LINK_RE.exec(markdown)) !== null) {
    const title = m[1].replace(/\bimage\s*\d+\s*:\s*/gi, "").trim();
    const url = m[2].trim();
    if (!title || seen.has(url)) continue;
    seen.add(url);
    posts.push({
      title,
      url,
      imageUrl: null,
      summary: null,
      publishedAt: nearbyDate(markdown, m.index + m[0].length),
    });
  }
  return posts.slice(0, 30);
}

function snippet(text) {
  return JSON.stringify((text || "").replace(/\s+/g, " ").trim().slice(0, 160));
}

async function tryRssAttempts() {
  const errors = [];
  for (const attempt of FETCH_ATTEMPTS) {
    try {
      const r = await fetch(FEED_URL, { headers: attempt.headers });
      const text = await r.text();
      if (!r.ok) {
        errors.push(`${attempt.label}: upstream responded ${r.status}, got ${snippet(text)}`);
        continue;
      }
      if (!looksLikeXml(text)) {
        errors.push(`${attempt.label}: not XML, got ${snippet(text)}`);
        continue;
      }
      const posts = parsePostsFromXml(text);
      if (!posts.length) {
        errors.push(`${attempt.label}: XML but no <item> posts parsed, got ${snippet(text)}`);
        continue;
      }
      return { posts, via: attempt.label };
    } catch (err) {
      errors.push(`${attempt.label}: ${String((err && err.message) || err)}`);
    }
  }
  const e = new Error("all RSS attempts failed: " + errors.join(" | "));
  e.details = errors;
  throw e;
}

async function tryHomepageScrape() {
  const r = await fetch(READER_URL);
  const markdown = await r.text();
  if (!r.ok) throw new Error(`reader upstream responded ${r.status}, got ${snippet(markdown)}`);

  const posts = parsePostsFromMarkdown(markdown);
  if (!posts.length) throw new Error(`no post links found in rendered homepage, got ${snippet(markdown)}`);
  return { posts, via: "homepage-scrape" };
}

export default async function handler(req, res) {
  const errors = [];
  try {
    const { posts, via } = await tryRssAttempts();
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=900");
    res.status(200).json({ fetchedAt: new Date().toISOString(), posts, via });
    return;
  } catch (e) {
    errors.push(e.message);
  }

  try {
    const { posts, via } = await tryHomepageScrape();
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=900");
    res.status(200).json({ fetchedAt: new Date().toISOString(), posts, via });
    return;
  } catch (e) {
    errors.push(e.message);
  }

  res.status(502).json({ error: "Bitcoin University feed fetch failed", details: errors });
}
