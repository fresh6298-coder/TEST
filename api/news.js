const FEEDS = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
  { url: "https://bitcoinmagazine.com/feed", source: "Bitcoin Magazine" },
  { url: "https://news.bitcoin.com/feed/", source: "Bitcoin.com News" },
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
};

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

function parseRss(xml, sourceName) {
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
    const imageUrl = extractImage(block);
    const publishedAt = pubDateStr ? Date.parse(pubDateStr) : NaN;

    if (title && link) {
      items.push({
        title,
        url: link.trim(),
        source: sourceName,
        imageUrl,
        body: description.replace(/<[^>]*>/g, "").trim().slice(0, 220),
        publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
      });
    }
  }
  return items;
}

const TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";
const MYMEMORY_URL = "https://api.mymemory.translated.net/get";

// translate.googleapis.com/translate_a/single is the unofficial endpoint
// the Google Translate website itself calls — it has no quota/API key and
// has started returning 429 "Sorry..." (Google's bot-block page) for
// server-side/datacenter traffic, which silently degrades every headline
// back to English (the `if (!res.ok) return text` fallback below hides the
// failure). MyMemory is tried first as a keyless, more tolerant
// alternative for this low-volume (title-only, 10-min-cached) use; Google
// stays as a second attempt in case the block is IP/region-specific rather
// than blanket, before finally giving up and returning the English title.
async function translateViaMyMemory(text) {
  const url = `${MYMEMORY_URL}?q=${encodeURIComponent(text)}&langpair=en|ko`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const res = await fetch(url, { signal: controller.signal });
  clearTimeout(timeout);
  if (!res.ok) throw new Error(`mymemory -> ${res.status}`);
  const data = await res.json();
  const translated = data && data.responseData && data.responseData.translatedText;
  if (!translated || /MYMEMORY WARNING/i.test(translated)) {
    throw new Error(`mymemory -> ${translated ? "quota exhausted" : "no translatedText"}`);
  }
  return translated;
}

async function translateViaGoogle(text) {
  const url = `${TRANSLATE_URL}?client=gtx&sl=en&tl=ko&dt=t&q=${encodeURIComponent(text)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const res = await fetch(url, {
    signal: controller.signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://translate.google.com/",
    },
  });
  clearTimeout(timeout);
  if (!res.ok) throw new Error(`google -> ${res.status}`);
  const data = await res.json();
  const translated = (data[0] || []).map((chunk) => chunk[0]).join("");
  if (!translated) throw new Error("google -> empty result");
  return translated;
}

async function translateToKorean(text) {
  if (!text) return { text, provider: "none" };
  try {
    return { text: await translateViaMyMemory(text), provider: "mymemory" };
  } catch (e1) {
    try {
      return { text: await translateViaGoogle(text), provider: "google" };
    } catch (e2) {
      return { text, provider: "failed", error: `${e1.message} | ${e2.message}` };
    }
  }
}

async function loadFeed(feed) {
  const r = await fetch(feed.url, { headers: HEADERS });
  if (!r.ok) {
    const err = new Error(`${feed.source}: upstream responded ${r.status}`);
    throw err;
  }
  const xml = await r.text();
  const items = parseRss(xml, feed.source);
  if (!items.length) throw new Error(`${feed.source}: no items parsed`);
  return items;
}

export default async function handler(req, res) {
  const results = await Promise.allSettled(FEEDS.map(loadFeed));

  let items = [];
  const errors = [];
  results.forEach((r) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors.push(r.reason.message);
  });

  if (!items.length) {
    res.status(502).json({ error: "All feeds failed", details: errors });
    return;
  }

  // Keep this focused on Bitcoin specifically, but don't let an overly
  // strict filter empty out the feed if a source phrases things differently.
  const btcOnly = items.filter((it) => /bitcoin|btc\b/i.test(it.title + " " + it.body));
  if (btcOnly.length >= 5) items = btcOnly;

  items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  items = items.slice(0, 24);

  const translateStats = { mymemory: 0, google: 0, failed: 0 };
  const translateErrors = [];
  await Promise.all(
    items.map(async (it) => {
      const result = await translateToKorean(it.title);
      it.titleKo = result.text;
      translateStats[result.provider] = (translateStats[result.provider] || 0) + 1;
      if (result.provider === "failed") translateErrors.push(result.error);
    })
  );

  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=300");
  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    items,
    errors,
    translateStats,
    translateErrors: translateErrors.slice(0, 3),
  });
}
