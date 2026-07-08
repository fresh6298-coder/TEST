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
  items = items.slice(0, 40);

  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=300");
  res.status(200).json({ fetchedAt: new Date().toISOString(), items, errors });
}
