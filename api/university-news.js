// Bitcoin University is the user's own beehiiv newsletter. Neither /feed
// nor its HTML <head> expose a usable RSS URL on this custom domain — /feed
// just falls through to the site's client-rendered SPA shell with no
// <link rel="alternate"> to discover (confirmed from the deployed
// function's raw error responses). But the homepage itself does list real
// post titles/links once rendered, the same way a browser (or Google's own
// crawler) would see it — it's just that a plain server-side fetch only
// gets the pre-render shell, not the JS-rendered content.
//
// The rest of this app already has a proven workaround for exactly this
// (see api/_lib/scrape.js, used by etf-flow.js and assets-market-cap.js):
// the r.jina.ai reader proxy renders the page like a browser and returns
// the result as markdown, which we scrape for post links below.
const HOME_URL = "https://bitcoin-university.beehiiv.com/";
const READER_URL = "https://r.jina.ai/" + HOME_URL;

// beehiiv's default post permalink shape.
const POST_LINK_RE = /\[([^\]]*)\]\((https:\/\/bitcoin-university\.beehiiv\.com\/p\/[^)\s]+)\)/g;

// Best-effort date near a link's position in the rendered markdown — dates
// on a beehiiv homepage usually sit right next to the title, but aren't
// part of the markdown link syntax itself, so this can't be exact.
const DATE_RE = /([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})|(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/;

function snippet(text) {
  return JSON.stringify((text || "").replace(/\s+/g, " ").trim().slice(0, 160));
}

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

export default async function handler(req, res) {
  try {
    const r = await fetch(READER_URL);
    const markdown = await r.text();
    if (!r.ok) throw new Error(`reader upstream responded ${r.status}, got ${snippet(markdown)}`);

    const posts = parsePostsFromMarkdown(markdown);
    if (!posts.length) throw new Error(`no post links found in rendered homepage, got ${snippet(markdown)}`);

    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=900");
    res.status(200).json({ fetchedAt: new Date().toISOString(), posts });
  } catch (e) {
    res.status(502).json({ error: "Bitcoin University feed fetch failed: " + e.message });
  }
}
