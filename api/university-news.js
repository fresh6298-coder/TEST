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

// Each post on the homepage renders as an image wrapped in a link to the
// post (`[![Image N: title](imgUrl)](postUrl)`), immediately followed by
// the real title as its own "### title" heading, then optionally a
// one-line summary, then a byline ("... 저널리스트"), a "•" separator, and
// a date. Every post also repeats later on the page (under "Featured" /
// "Latest" sections) usually with the summary/byline stripped out, so we
// only keep the first (richest) occurrence of each URL.
const POST_URL_RE = /\]\((https:\/\/bitcoin-university\.beehiiv\.com\/p\/[^)\s]+)\)/g;
const HEADING_RE = /^\s*\n+###\s+(.+?)\s*\n/;
const DATE_RE = /([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})|(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/;
const BYLINE_RE = /저널리스트|^by\s/i;

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

    const rest = markdown.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const heading = rest.match(HEADING_RE);
    if (!heading) continue; // not actually a post card (e.g. a stray nav link)
    const title = heading[1].trim();
    if (!title) continue;

    seen.add(url);

    const afterHeading = rest.slice(heading.index + heading[0].length);
    let summary = null;
    for (const line of afterHeading.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (line === "•" || DATE_RE.test(line)) break;
      if (BYLINE_RE.test(line)) continue;
      summary = line;
      break;
    }

    posts.push({ title, url, imageUrl: null, summary, publishedAt: parseDate(rest) });
  }
  posts.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
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
