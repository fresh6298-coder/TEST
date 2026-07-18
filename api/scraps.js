// Cross-device sync, keyed by a random "sync code" the user generates
// client-side and enters on each device (no login) — same mechanism as
// the fiat/economics project's api/notes.js. Handles two independent
// kinds of saved items under the same sync code: news scraps (the
// original use of this file, key `scraps:${code}`) and saved Q&A pairs
// from ask.html (key `qa-notes:${code}`), distinguished by a `kind`
// field so a second serverless function didn't need to be added (see
// api/bgeo-data.js's comment for why that limit matters here).
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const MAX_SCRAPS = 300;
const MAX_NOTES = 300;
const CODE_RE = /^[a-z0-9-]{6,64}$/i;

function redisConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`redis GET failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function redisSet(key, value) {
  const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "text/plain" },
    body: value,
  });
  if (!res.ok) throw new Error(`redis SET failed: ${res.status}`);
  return res.json();
}

function loadArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeCode(code) {
  return typeof code === "string" ? code.trim() : "";
}

function str(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

async function handleScraps(req, res, code, body) {
  const key = `scraps:${code}`;

  if (req.method === "GET") {
    const raw = await redisGet(key);
    res.status(200).json({ scraps: loadArray(raw) });
    return;
  }

  if (req.method === "POST") {
    const title = str(body.title, 300);
    const url = str(body.url, 2000);
    if (!title || !url) {
      res.status(400).json({ error: "저장할 기사 제목/링크가 없습니다." });
      return;
    }
    const scrap = {
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      title,
      titleKo: str(body.titleKo, 300),
      url,
      source: str(body.source, 120),
      imageUrl: str(body.imageUrl, 2000),
      publishedAt: typeof body.publishedAt === "number" ? body.publishedAt : null,
      savedAt: new Date().toISOString(),
    };
    const existing = loadArray(await redisGet(key));
    // De-dupe by URL so re-tapping "scrap" on the same article doesn't
    // pile up duplicates.
    const deduped = existing.filter((n) => n.url !== scrap.url);
    const updated = [scrap, ...deduped].slice(0, MAX_SCRAPS);
    await redisSet(key, JSON.stringify(updated));
    res.status(200).json({ scraps: updated });
    return;
  }

  if (req.method === "DELETE") {
    const id = typeof body.id === "string" ? body.id : "";
    const existing = loadArray(await redisGet(key));
    const updated = id ? existing.filter((n) => n.id !== id) : [];
    await redisSet(key, JSON.stringify(updated));
    res.status(200).json({ scraps: updated });
    return;
  }

  res.status(405).json({ error: "GET/POST/DELETE 요청만 지원합니다." });
}

async function handleNotes(req, res, code, body) {
  const key = `qa-notes:${code}`;

  if (req.method === "GET") {
    const raw = await redisGet(key);
    res.status(200).json({ notes: loadArray(raw) });
    return;
  }

  if (req.method === "POST") {
    const question = str(body.question, 800);
    const answer = str(body.answer, 4000);
    if (!question || !answer) {
      res.status(400).json({ error: "저장할 질문/답변이 없습니다." });
      return;
    }
    const note = {
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      question,
      answer,
      savedAt: new Date().toISOString(),
    };
    const existing = loadArray(await redisGet(key));
    const updated = [note, ...existing].slice(0, MAX_NOTES);
    await redisSet(key, JSON.stringify(updated));
    res.status(200).json({ notes: updated });
    return;
  }

  if (req.method === "DELETE") {
    const id = typeof body.id === "string" ? body.id : "";
    const existing = loadArray(await redisGet(key));
    const updated = id ? existing.filter((n) => n.id !== id) : [];
    await redisSet(key, JSON.stringify(updated));
    res.status(200).json({ notes: updated });
    return;
  }

  res.status(405).json({ error: "GET/POST/DELETE 요청만 지원합니다." });
}

export default async function handler(req, res) {
  if (!redisConfigured()) {
    res.status(500).json({ error: "서버에 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 환경변수가 설정되어 있지 않습니다." });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const codeSource = req.method === "GET" ? (req.query && req.query.code) : body.code;
    const code = normalizeCode(codeSource);
    if (!CODE_RE.test(code)) {
      res.status(400).json({ error: "동기화 코드 형식이 올바르지 않습니다." });
      return;
    }

    const kind = (req.query && req.query.kind) || body.kind || "scrap";
    if (kind === "note") {
      await handleNotes(req, res, code, body);
    } else {
      await handleScraps(req, res, code, body);
    }
  } catch (err) {
    res.status(500).json({ error: "동기화 서버 처리 중 오류가 발생했습니다.", detail: String(err).slice(0, 500) });
  }
}
