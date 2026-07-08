import { fetchTableWithFallback, parseNumber } from "./_lib/scrape.js";

const SOURCE_URL = "https://farside.co.uk/btc/";
const READER_URL = "https://r.jina.ai/https://farside.co.uk/btc/";

function buildResult(rawRows, source) {
  const headers = rawRows[0];
  const totalIdx = headers.findIndex((h) => /total/i.test(h));

  const dataRows = rawRows
    .slice(1)
    .filter((r) => r.length === headers.length && r[0])
    .filter((r) => !/^total/i.test(r[0]))
    .map((r) => {
      const values = {};
      headers.slice(1).forEach((h, i) => {
        values[h] = parseNumber(r[i + 1]);
      });
      return {
        date: r[0],
        values,
        total: totalIdx >= 0 ? parseNumber(r[totalIdx]) : null,
      };
    });

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
