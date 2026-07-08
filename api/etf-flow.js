const SOURCE_URL = "https://farside.co.uk/btc/";
const READER_URL = "https://r.jina.ai/https://farside.co.uk/btc/";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.google.com/",
};

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

function stripMarkdown(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/[*_`]/g, "")
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

function parseHtmlTable(tableHtml) {
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

function bestHtmlTableRows(html) {
  const tables = extractTables(html)
    .map(parseHtmlTable)
    .filter((rows) => rows.length > 2);
  if (!tables.length) return null;
  return tables.reduce((a, b) => (b.length > a.length ? b : a));
}

// r.jina.ai returns the page as markdown; pipe tables look like:
// | Date | IBIT | FBTC | ... | Total |
// | --- | --- | --- | ... | --- |
// | 14 Jan 2026 | 100.1 | (20.3) | ... | 50.2 |
function bestMarkdownTableRows(markdown) {
  const lines = markdown.split("\n").map((l) => l.trim());
  const isSeparator = (l) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l);
  const isTableLine = (l) => l.startsWith("|") && l.endsWith("|");

  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (isTableLine(line)) {
      if (!isSeparator(line)) current.push(line);
    } else if (current.length) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  if (!blocks.length) return null;

  const best = blocks.reduce((a, b) => (b.length > a.length ? b : a));
  return best.map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => stripMarkdown(cell))
  );
}

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
  const errors = [];

  try {
    const direct = await fetch(SOURCE_URL, { headers: BROWSER_HEADERS });
    if (direct.ok) {
      const html = await direct.text();
      const rawRows = bestHtmlTableRows(html);
      if (rawRows) {
        res.setHeader(
          "Cache-Control",
          "public, s-maxage=3600, stale-while-revalidate=1800"
        );
        res.status(200).json(buildResult(rawRows, SOURCE_URL));
        return;
      }
      errors.push("direct: no data table found in HTML");
    } else {
      errors.push(`direct: upstream responded ${direct.status}`);
    }
  } catch (err) {
    errors.push(`direct: ${String((err && err.message) || err)}`);
  }

  try {
    const viaReader = await fetch(READER_URL);
    if (viaReader.ok) {
      const markdown = await viaReader.text();
      const rawRows = bestMarkdownTableRows(markdown);
      if (rawRows) {
        res.setHeader(
          "Cache-Control",
          "public, s-maxage=3600, stale-while-revalidate=1800"
        );
        res.status(200).json(buildResult(rawRows, READER_URL));
        return;
      }
      errors.push("reader: no data table found in markdown");
    } else {
      errors.push(`reader: upstream responded ${viaReader.status}`);
    }
  } catch (err) {
    errors.push(`reader: ${String((err && err.message) || err)}`);
  }

  res.status(502).json({ error: "All fetch strategies failed", details: errors });
}
