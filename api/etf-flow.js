import { fetchTableWithFallback, parseNumber } from "./_lib/scrape.js";

// The plain /btc/ page only server-renders a recent window of rows (older
// history loads client-side); /bitcoin-etf-flow-all-data/ is farside's
// dedicated full-history page, back to the Jan 2024 launch.
const SOURCE_URL = "https://farside.co.uk/bitcoin-etf-flow-all-data/";
const READER_URL = "https://r.jina.ai/https://farside.co.uk/bitcoin-etf-flow-all-data/";

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

// Farside's date column reads like "11th Jan 2024" — the ordinal suffix
// makes it unparseable by plain `new Date(...)`. Strip it and parse
// explicitly instead of relying on the runtime's (locale-dependent) date
// string parser.
function parseFarsideDate(text) {
  const raw = String(text || "").trim();
  const m = raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\s+(\d{4})$/i);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const year = parseInt(m[3], 10);
    if (month != null && !Number.isNaN(day) && !Number.isNaN(year)) {
      return Date.UTC(year, month, day);
    }
  }
  // Fall back to native parsing in case the format differs from the
  // "11th Jan 2024" pattern above.
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function buildResult(rawRows, source) {
  const headers = rawRows[0];
  const totalIdx = headers.findIndex((h) => /total/i.test(h));

  const dataRows = rawRows
    .slice(1)
    .filter((r) => r.length === headers.length && r[0])
    .filter((r) => !/^(total|average|maximum|minimum|max|min)\b/i.test(r[0]))
    .map((r) => {
      const values = {};
      headers.slice(1).forEach((h, i) => {
        values[h] = parseNumber(r[i + 1]);
      });
      return {
        date: r[0],
        dateMs: parseFarsideDate(r[0]),
        values,
        total: totalIdx >= 0 ? parseNumber(r[totalIdx]) : null,
      };
    })
    .filter((r) => r.dateMs != null);

  return {
    source,
    fetchedAt: new Date().toISOString(),
    headers,
    rows: dataRows,
  };
}

export default async function handler(req, res) {
  try {
    const { rawRows, source } = await fetchTableWithFallback(
      SOURCE_URL,
      READER_URL
    );
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=1800"
    );
    res.status(200).json(buildResult(rawRows, source));
  } catch (err) {
    res
      .status(502)
      .json({ error: err.message, details: err.details || [] });
  }
}
