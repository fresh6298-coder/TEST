const SOURCE_URL = "https://farside.co.uk/btc/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(text) {
  const t = (text || "").trim();
  if (t === "" || t === "-" || /^n\/?a$/i.test(t)) return null;
  const negative = /^\(.*\)$/.test(t);
  const cleaned = t.replace(/[(),]/g, "");
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

function extractTables(html) {
  const tables = [];
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRegex.exec(html)) !== null) {
    tables.push(m[1]);
  }
  return tables;
}

function parseTable(tableHtml) {
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRegex.exec(tableHtml)) !== null) {
    const rowHtml = rm[1];
    const cells = [];
    const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cm;
    while ((cm = cellRegex.exec(rowHtml)) !== null) {
      cells.push(stripTags(cm[1]));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

export default async function handler(req, res) {
  try {
    const upstream = await fetch(SOURCE_URL, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `Upstream responded ${upstream.status}` });
      return;
    }
    const html = await upstream.text();
    const tables = extractTables(html)
      .map(parseTable)
      .filter((rows) => rows.length > 2);

    if (!tables.length) {
      res.status(502).json({ error: "No data table found on source page" });
      return;
    }

    const rawRows = tables.reduce((a, b) => (b.length > a.length ? b : a));
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

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=1800"
    );
    res.status(200).json({
      source: SOURCE_URL,
      fetchedAt: new Date().toISOString(),
      headers,
      rows: dataRows,
    });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
