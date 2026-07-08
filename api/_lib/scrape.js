export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.google.com/",
};

export function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function stripMarkdown(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseNumber(text) {
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

export function bestHtmlTableRows(html) {
  const tables = extractTables(html)
    .map(parseHtmlTable)
    .filter((rows) => rows.length > 2);
  if (!tables.length) return null;
  return tables.reduce((a, b) => (b.length > a.length ? b : a));
}

// r.jina.ai's reader renders pages as markdown; pipe tables look like:
// | Rank | Name | Market Cap | Price | Today |
// | --- | --- | --- | --- | --- |
// | 1 | Gold | $22.831 T | ... | 0.12% |
export function bestMarkdownTableRows(markdown) {
  const lines = markdown.split("\n").map((l) => l.trim());
  const isSeparator = (l) =>
    /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l);
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

// Tries a direct fetch with browser-like headers first (works for sites with
// basic checks), then falls back to the r.jina.ai reader proxy (works around
// bot-management that blocks datacenter IPs outright). Returns
// { rawRows, source } on success, or throws with a `details` array of every
// strategy's failure reason.
export async function fetchTableWithFallback(sourceUrl, readerUrl) {
  const errors = [];

  try {
    const direct = await fetch(sourceUrl, { headers: BROWSER_HEADERS });
    if (direct.ok) {
      const html = await direct.text();
      const rawRows = bestHtmlTableRows(html);
      if (rawRows) return { rawRows, source: sourceUrl };
      errors.push("direct: no data table found in HTML");
    } else {
      errors.push(`direct: upstream responded ${direct.status}`);
    }
  } catch (err) {
    errors.push(`direct: ${String((err && err.message) || err)}`);
  }

  try {
    const viaReader = await fetch(readerUrl);
    if (viaReader.ok) {
      const markdown = await viaReader.text();
      const rawRows = bestMarkdownTableRows(markdown);
      if (rawRows) return { rawRows, source: readerUrl };
      errors.push("reader: no data table found in markdown");
    } else {
      errors.push(`reader: upstream responded ${viaReader.status}`);
    }
  } catch (err) {
    errors.push(`reader: ${String((err && err.message) || err)}`);
  }

  const err = new Error("All fetch strategies failed");
  err.details = errors;
  throw err;
}
