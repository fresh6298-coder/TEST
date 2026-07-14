// Bitcoin University is the user's own beehiiv newsletter. Requesting
// /feed directly returns the site's own SPA HTML shell (a 200 response
// starting with "<!DOCTYPE html>...") rather than XML — /feed isn't a real
// route on the custom domain, it just falls through to the client app's
// catch-all. Real RSS readers work around this via feed autodiscovery: the
// HTML <head> still advertises the actual feed URL via a
// <link rel="alternate" type="application/rss+xml" href="..."> tag, so we
// fetch that HTML, extract the real feed URL, and fetch that instead.
const START_URL = "https://bitcoin-university.beehiiv.com/feed";

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

function looksLikeXml(text) {
  return /^\s*(<\?xml|<rss[\s>]|<feed[\s>])/i.test(text);
}

function discoverFeedUrl(html, baseUrl) {
  const m = html.match(
    /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i
  );
  if (!m) return null;
  const hrefMatch = m[0].match(/href=["']([^"']+)["']/i);
  if (!hrefMatch) return null;
  try {
    return new URL(hrefMatch[1], baseUrl).toString();
  } catch {
    return null;
  }
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

async function fetchFeedXml() {
  const r1 = await fetch(START_URL, { headers: HEADERS });
  const text1 = await r1.text();
  if (!r1.ok) throw new Error(`upstream responded ${r1.status}, got ${snippet(text1)}`);
  if (looksLikeXml(text1)) return text1;

  const discovered = discoverFeedUrl(text1, START_URL);
  if (!discovered) {
    throw new Error(
      `/feed returned HTML with no <link rel="alternate" type="application/rss+xml"> to discover, got ${snippet(text1)}`
    );
  }
  const r2 = await fetch(discovered, { headers: HEADERS });
  const text2 = await r2.text();
  if (!r2.ok) throw new Error(`discovered feed ${discovered} responded ${r2.status}, got ${snippet(text2)}`);
  if (!looksLikeXml(text2)) {
    throw new Error(`discovered feed ${discovered} wasn't XML either, got ${snippet(text2)}`);
  }
  return text2;
}

export default async function handler(req, res) {
  try {
    const xml = await fetchFeedXml();
    const posts = parsePosts(xml);
    if (!posts.length) throw new Error(`no posts parsed, got ${snippet(xml)}`);

    posts.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=900");
    res.status(200).json({ fetchedAt: new Date().toISOString(), posts });
  } catch (e) {
    res.status(502).json({ error: "Bitcoin University feed fetch failed: " + e.message });
  }
}
