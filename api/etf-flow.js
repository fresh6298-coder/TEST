import { fetchTableWithFallback, parseNumber } from "./_lib/scrape.js";

// farside.co.uk's dedicated full-history page (/bitcoin-etf-flow-all-data/)
// carries the complete series back to the Jan 2024 launch, but its bot
// protection is intermittent — it 403s sometimes and not other times,
// rather than being blocked outright. So it's tried first (for the full
// history when it's reachable), falling back to the regular /btc/ page
// (only a recent window, but far more reliably reachable) when it isn't.
const FARSIDE_SOURCES = [
  {
    source: "https://farside.co.uk/bitcoin-etf-flow-all-data/",
    reader: "https://r.jina.ai/https://farside.co.uk/bitcoin-etf-flow-all-data/",
  },
  {
    source: "https://farside.co.uk/btc/",
    reader: "https://r.jina.ai/https://farside.co.uk/btc/",
  },
];

// bitcoin-data.com (BGeometrics — the same provider api/onchain-metrics.js
// already uses successfully for MVRV/NUPL/Puell) also tracks ETF flows,
// and unlike farside its history isn't capped to a recent window. The
// exact endpoint path isn't confirmed (docs weren't reachable to verify),
// so a few plausible candidates are tried and whichever returns a
// substantial, parseable series wins; if none do, this falls through to
// the farside scrape below rather than breaking anything.
const BGEO_BASE = "https://bitcoin-data.com/v1";
const BGEO_ETF_PATHS = ["etf-flow", "etf-flows", "btc-etf-flow", "bitcoin-etf-flow", "etf"];
const BGEO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};
const MIN_BGEO_ROWS = 100; // farside's recent-window fallback tops out well under this

const NON_VALUE_KEY = /^(d|date|id|unix.*|timestamp|ts|epoch|createdat|updatedat)$/i;

function isNumeric(v) {
  return typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(parseFloat(v)));
}

// Row shape isn't known in advance, so this stays generic: whichever key
// looks like a date becomes the date, everything else numeric becomes a
// per-issuer value, and a "total"-looking key (or else the sum of the
// other numeric fields) becomes the total.
function normalizeBgeoEtfRow(row) {
  if (!row || typeof row !== "object") return null;
  const keys = Object.keys(row);
  const dateKey = keys.find((k) => /^(d|date)$/i.test(k)) || keys.find((k) => /time|timestamp/i.test(k));
  if (!dateKey) return null;
  const dateMs = Date.parse(row[dateKey]);
  if (Number.isNaN(dateMs)) return null;

  const valueKeys = keys.filter((k) => k !== dateKey && !NON_VALUE_KEY.test(k) && isNumeric(row[k]));
  if (!valueKeys.length) return null;

  const totalKey = valueKeys.find((k) => /total/i.test(k));
  const values = {};
  valueKeys.forEach((k) => {
    if (k !== totalKey) values[k] = parseFloat(row[k]);
  });
  const rawTotal = totalKey
    ? parseFloat(row[totalKey])
    : valueKeys.reduce((sum, k) => sum + parseFloat(row[k]), 0);
  const total = Math.round(rawTotal * 10) / 10;

  const d = new Date(dateMs);
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return {
    date: `${String(d.getUTCDate()).padStart(2, "0")} ${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    dateMs,
    values,
    total,
  };
}

async function fetchBgeoEtfFlow() {
  for (const path of BGEO_ETF_PATHS) {
    try {
      const res = await fetch(`${BGEO_BASE}/${path}`, { headers: BGEO_HEADERS });
      if (!res.ok) continue;
      const json = await res.json();
      const rawRows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : null;
      if (!rawRows || !rawRows.length) continue;

      const rows = rawRows.map(normalizeBgeoEtfRow).filter(Boolean).sort((a, b) => a.dateMs - b.dateMs);
      if (rows.length >= MIN_BGEO_ROWS) {
        const headerSet = new Set();
        rows.forEach((r) => Object.keys(r.values).forEach((k) => headerSet.add(k)));
        return {
          source: `${BGEO_BASE}/${path}`,
          headers: ["Date", ...headerSet, "Total"],
          rows,
        };
      }
    } catch {
      // try the next candidate path
    }
  }
  return null;
}

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

async function fetchFarsideRows() {
  const errors = [];
  for (const { source, reader } of FARSIDE_SOURCES) {
    try {
      const result = await fetchTableWithFallback(source, reader);
      if (result.rawRows && result.rawRows.length > 2) return result;
    } catch (err) {
      errors.push(`${source}: ${err.message}`);
    }
  }
  const err = new Error("All farside sources failed");
  err.details = errors;
  throw err;
}

// ---- Persistent archive (Upstash Redis) ----
// farside's full-history page 403s intermittently rather than always —
// the fix isn't to keep re-fetching it hopefully, it's to permanently
// keep whatever it gives us the next time it *does* work. Every
// invocation merges freshly-fetched rows into a Redis-backed archive
// (fresh values win for overlapping dates, nothing already captured is
// ever dropped), so one lucky full-history fetch is enough to backfill
// the Jan 2024 gap for good — after that, the reliably-reachable
// recent-window page is all that's needed to keep the tail current.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ARCHIVE_KEY = "etf-flow-archive";

function redisConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisGetArchive() {
  const res = await fetch(`${REDIS_URL}/get/${ARCHIVE_KEY}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`redis GET failed: ${res.status}`);
  const data = await res.json();
  if (!data.result) return [];
  try {
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function redisSetArchive(rows) {
  await fetch(`${REDIS_URL}/set/${ARCHIVE_KEY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "text/plain" },
    body: JSON.stringify(rows),
  });
}

function mergeRows(existing, fresh) {
  const byDate = new Map(existing.map((r) => [r.dateMs, r]));
  fresh.forEach((r) => byDate.set(r.dateMs, r)); // fresh always wins for overlapping dates
  return [...byDate.values()].sort((a, b) => a.dateMs - b.dateMs);
}

function headersFor(rows) {
  const keys = new Set();
  rows.forEach((r) => Object.keys(r.values || {}).forEach((k) => keys.add(k)));
  return ["Date", ...keys, "Total"];
}

export default async function handler(req, res) {
  let fresh = null; // {source, rows}
  try {
    const bgeoResult = await fetchBgeoEtfFlow();
    if (bgeoResult) {
      fresh = { source: bgeoResult.source, rows: bgeoResult.rows };
    } else {
      const { rawRows, source } = await fetchFarsideRows();
      fresh = { source, rows: buildResult(rawRows, source).rows };
    }
  } catch (err) {
    fresh = null;
  }

  if (!redisConfigured()) {
    // No persistent archive available — behave exactly as before,
    // returning whatever this single request managed to fetch (or 502).
    if (!fresh) {
      res.status(502).json({ error: "ETF 데이터 조회 실패 (모든 소스 실패)" });
      return;
    }
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
    res.status(200).json({
      source: fresh.source,
      fetchedAt: new Date().toISOString(),
      headers: headersFor(fresh.rows),
      rows: fresh.rows,
    });
    return;
  }

  try {
    const existing = await redisGetArchive();
    const merged = fresh ? mergeRows(existing, fresh.rows) : existing;
    if (fresh) await redisSetArchive(merged).catch(() => {});

    if (!merged.length) {
      res.status(502).json({ error: "ETF 데이터 조회 실패 (아카이브 비어있음, 모든 소스 실패)" });
      return;
    }

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
    res.status(200).json({
      source: fresh ? fresh.source : "cache",
      fetchedAt: new Date().toISOString(),
      headers: headersFor(merged),
      rows: merged,
    });
  } catch (err) {
    // Redis itself failed (rare) — fall back to just this request's fresh
    // fetch rather than erroring out entirely.
    if (fresh) {
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
      res.status(200).json({
        source: fresh.source,
        fetchedAt: new Date().toISOString(),
        headers: headersFor(fresh.rows),
        rows: fresh.rows,
      });
      return;
    }
    res.status(502).json({ error: "ETF 데이터 조회 실패: " + err.message });
  }
}
