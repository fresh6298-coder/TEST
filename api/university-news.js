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

function snippet(text, len) {
  return JSON.stringify((text || "").replace(/\s+/g, " ").trim().slice(0, len || 160));
}

export default async function handler(req, res) {
  try {
    const r = await fetch(READER_URL);
    const markdown = await r.text();
    if (!r.ok) throw new Error(`reader upstream responded ${r.status}, got ${snippet(markdown)}`);

    // ?debug=1 dumps the raw rendered markdown so the link/date structure
    // can be inspected directly instead of guessing from a short snippet.
    if (req.query && req.query.debug) {
      res.status(200).json({ markdown });
      return;
    }

    const posts = parsePostsFromMarkdown(markdown);
    if (!posts.length) {
      throw new Error(`no post links found in rendered homepage, got ${snippet(markdown, 4000)}`);
    }

    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=900");
    res.status(200).json({ fetchedAt: new Date().toISOString(), posts });
  } catch (e) {
    res.status(502).json({ error: "Bitcoin University feed fetch failed: " + e.message });
  }
}
