// Bitcoin University is the user's own beehiiv newsletter. beehiiv's free
// (Launch) plan has no public API access (Scale+ only), but this specific
// RSS feed URL was manually generated/provided by the user, so we can treat
// it like any other RSS source (see api/news.js) instead of maintaining a
// static JSON file by hand.
const FEED_URL = "https://bitcoin-university.beehiiv.com/feed";

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

function snippet(text) {
  return JSON.stringify((text || "").replace(/\s+/g, " ").trim().slice(0, 160));
}

function parsePosts(xml) {
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
        imageUrl,
        summary: description.replace(/<[^>]*>/g, "").trim().slice(0, 280),
        publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
      });
    }
  }
  return items;
}

export default async function handler(req, res) {
  try {
    const r = await fetch(FEED_URL, { headers: HEADERS });
    const text = await r.text();
    if (!r.ok) throw new Error(`upstream responded ${r.status}, got ${snippet(text)}`);

    const posts = parsePosts(text);
    if (!posts.length) throw new Error(`no posts parsed, got ${snippet(text)}`);

    posts.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=900");
    res.status(200).json({ fetchedAt: new Date().toISOString(), posts });
  } catch (e) {
    res.status(502).json({ error: "Bitcoin University feed fetch failed: " + e.message });
  }
}
