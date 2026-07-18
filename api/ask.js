// Q&A endpoint for ask.html, modeled on the same pattern used in the
// user's other project (fiat's api/ask.js): a static knowledge-base text
// block plus conversation history sent to Gemini as a system prompt. The
// difference here is bitdash's data is live/numeric rather than static
// lecture text, so a "live data snapshot" built from this app's own
// endpoints is appended to the system prompt alongside the static
// concept explanations.
import fs from "fs";
import path from "path";

const KB_PATH = path.join(process.cwd(), "data", "ask-knowledge-base.json");
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const MAX_QUESTION_LEN = 800;
const MAX_HISTORY_TURNS = 6;

let cachedKbText = null;

function buildKbText() {
  if (cachedKbText) return cachedKbText;
  const entries = JSON.parse(fs.readFileSync(KB_PATH, "utf-8"));
  cachedKbText = entries.map((e) => `### ${e.title}\n${e.body}`).join("\n\n");
  return cachedKbText;
}

async function fetchJsonSafe(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Rebuilt at most once every 10 minutes per warm serverless instance —
// frequent enough that numbers don't go stale for a chat session, rare
// enough that every question doesn't re-fetch four internal endpoints.
const LIVE_TTL_MS = 10 * 60 * 1000;
let liveCache = { text: "", builtAt: 0 };

const METRIC_LABELS = {
  mvrvZscore: "MVRV Z-Score",
  nupl: "NUPL",
  puellMultiple: "Puell Multiple",
  sopr: "SOPR",
  reserveRisk: "Reserve Risk",
  aviv: "AVIV Ratio",
  stockToFlow: "Stock-to-Flow",
};

async function buildLiveSnapshot(host) {
  if (liveCache.text && Date.now() - liveCache.builtAt < LIVE_TTL_MS) return liveCache.text;

  const base = `https://${host}`;
  const [onchain, etf, waves, btc] = await Promise.all([
    fetchJsonSafe(`${base}/api/onchain-metrics?summary=1`),
    fetchJsonSafe(`${base}/api/etf-flow`),
    fetchJsonSafe(`${base}/api/hodl-waves`),
    fetchJsonSafe(`${base}/api/btc-history`),
  ]);

  const lines = [];

  if (btc && btc.prices) {
    const dates = Object.keys(btc.prices).sort();
    const lastDate = dates[dates.length - 1];
    if (lastDate != null) {
      lines.push(`BTC 가격 (${lastDate} 종가 기준): $${Math.round(btc.prices[lastDate]).toLocaleString("en-US")}`);
    }
  }

  if (onchain && onchain.metrics) {
    Object.entries(onchain.metrics).forEach(([key, m]) => {
      if (!m || !m.current) return;
      lines.push(`${METRIC_LABELS[key] || key}: ${m.current.value} (기준일 ${m.current.date})`);
    });
  }

  if (etf && Array.isArray(etf.rows) && etf.rows.length) {
    const latest = etf.rows[etf.rows.length - 1];
    const last7 = etf.rows.slice(-7).reduce((s, r) => s + (r.total || 0), 0);
    const sign = (v) => (v >= 0 ? "+" : "");
    lines.push(
      `ETF 순유입 최신값 (${latest.date}): ${sign(latest.total)}${latest.total}M 달러, 최근 7일 합계: ${sign(last7)}${last7.toFixed(1)}M 달러`
    );
  }

  if (waves && Array.isArray(waves.history) && waves.history.length && Array.isArray(waves.bandKeys)) {
    const latest = waves.history[waves.history.length - 1];
    const total = waves.bandKeys.reduce((s, k) => s + (latest.bands[k] || 0), 0) || 1;
    const parts = waves.bandKeys.map((k) => `${k} ${((latest.bands[k] || 0) / total * 100).toFixed(1)}%`);
    lines.push(`HODL Waves 최신 스냅샷 (${latest.date}): ${parts.join(", ")}`);
  }

  liveCache = {
    text: lines.length ? lines.join("\n") : "(지금 실시간 데이터를 불러오지 못했습니다. 개념 설명 위주로만 답변하세요.)",
    builtAt: Date.now(),
  };
  return liveCache.text;
}

// University column full text changes far less often than price/on-chain
// data, so this gets its own longer-lived cache. api/university-news.js
// backfills at most one new article's full text per call (bounded
// latency), so the archive it returns grows over time regardless of
// whether ask.js or university.html triggered that particular call.
const ARTICLES_TTL_MS = 30 * 60 * 1000;
let articlesCache = { text: "", builtAt: 0 };

async function buildUniversityArticlesText(host) {
  if (articlesCache.text && Date.now() - articlesCache.builtAt < ARTICLES_TTL_MS) return articlesCache.text;

  const data = await fetchJsonSafe(`https://${host}/api/university-news`);
  // The full corpus is small enough (a few dozen posts at most) that
  // there's no real reason to only show the AI the most recent handful —
  // capped at 20 mainly so the prompt doesn't grow unbounded as the
  // archive keeps accumulating over the coming months/years.
  const articles = (data && Array.isArray(data.fullArticles) ? data.fullArticles : []).slice(0, 20);

  const text = articles.length
    ? articles
        .map((a) => `[${a.title}]\n${a.body.slice(0, 1200)}`)
        .join("\n\n")
    : "(아직 저장된 칼럼 본문이 없습니다.)";

  articlesCache = { text, builtAt: Date.now() };
  return text;
}

// ---- Weekly market report (GET /api/ask) ----
// Anchored to Korea Standard Time (UTC+9, no DST) so "this week" always
// means Mon-Sun as a Korean reader would expect, regardless of the
// server's own timezone. The report is cached in Redis keyed by the
// week's ending Sunday date, so it's generated by Gemini at most once
// per week no matter how many times the page is opened.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function kstDateString(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function kstDayOfWeek(ms) {
  return new Date(ms + KST_OFFSET_MS).getUTCDay(); // 0 = Sunday
}

// The Sunday that ends "this week" — today itself if today already is a
// Sunday in KST, otherwise the most recent past Sunday.
function currentWeekEndDateStr(nowMs) {
  const sundayMs = nowMs - kstDayOfWeek(nowMs) * DAY_MS;
  return kstDateString(sundayMs);
}

function valueAtOrBefore(series, targetMs) {
  let best = null;
  for (const p of series) {
    if (p.dateMs == null || p.dateMs > targetMs) continue;
    if (!best || p.dateMs > best.dateMs) best = p;
  }
  return best;
}

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisGetReport(key) {
  const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.result) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

async function redisSetReport(key, value) {
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "text/plain" },
    body: JSON.stringify(value),
  });
}

function pctChange(from, to) {
  if (from == null || to == null || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

function fmtPct(v) {
  if (v == null) return "N/A";
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

// Same power-law model as cycles.html's "가격 멱법칙 모델" panel
// (Santostasi & Perrenod: log10 P(t) = -16.509 + 5.690·log10 t, t = days
// since genesis) — pure math, no fetch needed, so this is computed
// locally rather than scraping the client-side chart.
const GENESIS_MS = Date.UTC(2009, 0, 3);
const PRICE_LAW_LOG_A = -16.509;
const PRICE_LAW_BETA = 5.69;
const PRICE_LAW_SIGMA_DEX = 0.302;

function priceLawFit(ms) {
  const t = (ms - GENESIS_MS) / DAY_MS;
  return Math.pow(10, PRICE_LAW_LOG_A + PRICE_LAW_BETA * Math.log10(t));
}

async function buildWeeklyDeltasText(host, weekStartMs, weekEndMs) {
  const base = `https://${host}`;
  const [onchain, etf, waves, btc, uni, macro] = await Promise.all([
    fetchJsonSafe(`${base}/api/onchain-metrics`),
    fetchJsonSafe(`${base}/api/etf-flow`),
    fetchJsonSafe(`${base}/api/hodl-waves`),
    fetchJsonSafe(`${base}/api/btc-history`),
    fetchJsonSafe(`${base}/api/university-news`),
    fetchJsonSafe(`${base}/api/macro-correlation`),
  ]);

  const lines = [];
  let btcStart = null, btcEnd = null;

  if (btc && btc.prices) {
    const series = Object.entries(btc.prices).map(([d, v]) => ({ dateMs: Date.parse(d), value: v }));
    btcStart = valueAtOrBefore(series, weekStartMs);
    btcEnd = valueAtOrBefore(series, weekEndMs);
    if (btcStart && btcEnd) {
      lines.push(
        `BTC 가격: $${Math.round(btcStart.value).toLocaleString("en-US")} → $${Math.round(btcEnd.value).toLocaleString("en-US")} (${fmtPct(pctChange(btcStart.value, btcEnd.value))})`
      );
    }
  }

  if (btcEnd) {
    const modelFit = priceLawFit(btcEnd.dateMs);
    const deviationPct = pctChange(modelFit, btcEnd.value);
    const sigmaDev = Math.log10(btcEnd.value / modelFit) / PRICE_LAW_SIGMA_DEX;
    const zone = sigmaDev >= 2 ? "모델 상단 밴드(+2σ) 초과" : sigmaDev <= -2 ? "모델 하단 밴드(-2σ) 미만" : "모델 밴드(±2σ) 내";
    lines.push(
      `가격 멱법칙 모델: 이론가 $${Math.round(modelFit).toLocaleString("en-US")} 대비 실제가 ${fmtPct(deviationPct)} (${zone})`
    );
  }

  if (macro && macro.assets && btcStart && btcEnd) {
    const btcChangePct = pctChange(btcStart.value, btcEnd.value);
    Object.entries(macro.assets).forEach(([label, closes]) => {
      const series = Object.entries(closes).map(([d, v]) => ({ dateMs: Date.parse(d), value: v }));
      const start = valueAtOrBefore(series, weekStartMs);
      const end = valueAtOrBefore(series, weekEndMs);
      if (!start || !end) return;
      const assetChangePct = pctChange(start.value, end.value);
      lines.push(`${label}: ${fmtPct(assetChangePct)} (BTC ${fmtPct(btcChangePct)})`);
    });
  }

  if (onchain && onchain.metrics) {
    Object.entries(onchain.metrics).forEach(([key, m]) => {
      if (!m || !Array.isArray(m.history) || !m.history.length) return;
      const start = valueAtOrBefore(m.history, weekStartMs);
      const end = valueAtOrBefore(m.history, weekEndMs);
      if (!start || !end) return;
      const label = METRIC_LABELS[key] || key;
      const round = (v) => Math.round(v * 1000) / 1000;
      lines.push(`${label}: ${round(start.value)} → ${round(end.value)} (${fmtPct(pctChange(start.value, end.value))})`);
    });
  }

  if (etf && Array.isArray(etf.rows) && etf.rows.length) {
    const weekRows = etf.rows.filter((r) => r.dateMs >= weekStartMs && r.dateMs <= weekEndMs);
    const weekTotal = weekRows.reduce((s, r) => s + (r.total || 0), 0);
    const sign = weekTotal >= 0 ? "+" : "";
    lines.push(`ETF 순유입 이번 주 합계 (${weekRows.length}일): ${sign}${weekTotal.toFixed(1)}M 달러`);
  }

  if (waves && Array.isArray(waves.history) && waves.history.length && Array.isArray(waves.bandKeys)) {
    const start = valueAtOrBefore(waves.history, weekStartMs);
    const end = valueAtOrBefore(waves.history, weekEndMs);
    if (start && end) {
      const startTotal = waves.bandKeys.reduce((s, k) => s + (start.bands[k] || 0), 0) || 1;
      const endTotal = waves.bandKeys.reduce((s, k) => s + (end.bands[k] || 0), 0) || 1;
      const shifts = waves.bandKeys
        .map((k) => ({ k, delta: (end.bands[k] || 0) / endTotal * 100 - (start.bands[k] || 0) / startTotal * 100 }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 3);
      lines.push(
        `HODL Waves 이번 주 가장 크게 움직인 구간: ` +
        shifts.map((s) => `${s.k} ${s.delta >= 0 ? "+" : ""}${s.delta.toFixed(1)}%p`).join(", ")
      );
    }
  }

  const uniPosts = uni && Array.isArray(uni.posts) ? uni.posts : [];
  const thisWeekPosts = uniPosts.filter((p) => p.publishedAt != null && p.publishedAt >= weekStartMs && p.publishedAt <= weekEndMs);
  const articlesText = thisWeekPosts.length
    ? thisWeekPosts.map((p) => `- ${p.title}${p.summary ? `: ${p.summary}` : ""}`).join("\n")
    : "(이번 주 새로 발행된 University 칼럼 없음)";

  return {
    statsText: lines.length ? lines.join("\n") : "(이번 주 데이터를 충분히 가져오지 못했습니다.)",
    articlesText,
    postCount: thisWeekPosts.length,
  };
}

function buildWeeklyReportPrompt(weekStartStr, weekEndStr, statsText, articlesText, kbText) {
  return `당신은 "bitdash" 비트코인 실시간 대시보드의 주간 시황 리포트 작성자입니다.

${weekStartStr} ~ ${weekEndStr} (한국시간 기준, 월요일~일요일) 한 주간의 데이터를 바탕으로, 이 기간의 시황과 인사이트를 한국어로 정리하세요.

규칙:
- 아래 "이번 주 지표 변화"에 있는 수치만 사실로 취급하고, 없는 수치를 지어내지 마세요.
- 구성: (1) 가격 요약 (2) 온체인 지표로 본 시장 심리/국면 (3) ETF 자금 흐름 해석 (4) HODL Waves로 본 보유자 동향 (5) 가격 멱법칙 모델 대비 현재 위치 및 금·나스닥·달러인덱스·코스피·삼성전자 대비 이번 주 상대 성과 (6) 이번 주 University 칼럼이 있다면 그 논지 반영 (7) 종합 인사이트 3~4문장.
- 확정적인 매수/매도 추천이나 가격 예측은 하지 말고, 지표가 역사적으로 어떻게 해석되는지에 근거해 설명하세요.
- 전체 400~600자 내외의 마크다운 텍스트로, 소제목은 "**제목**" 형식을 사용하세요.

=== 이번 주 지표 변화 (${weekStartStr} → ${weekEndStr}) ===
${statsText}

=== 이번 주 University 칼럼 ===
${articlesText}

=== 지표 개념 참고 자료 ===
${kbText}`;
}

async function callGemini(apiKey, systemPrompt, contents) {
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
  if (!upstream.ok) {
    const errText = await upstream.text();
    const err = new Error("AI 응답 생성에 실패했습니다.");
    err.detail = errText.slice(0, 500);
    throw err;
  }
  const data = await upstream.json();
  const candidate = (data.candidates || [])[0];
  const text = ((candidate && candidate.content && candidate.content.parts) || [])
    .map((part) => part.text || "")
    .join("\n")
    .trim();
  return {
    text,
    blocked: !text && data.promptFeedback && data.promptFeedback.blockReason,
    truncated: Boolean(candidate && candidate.finishReason === "MAX_TOKENS"),
  };
}

async function handleWeeklyReport(req, res, apiKey) {
  const weekEndStr = currentWeekEndDateStr(Date.now());
  const weekEndMs = Date.parse(weekEndStr + "T23:59:59+09:00");
  const weekStartMs = weekEndMs - 6 * DAY_MS;
  const weekStartStr = kstDateString(weekStartMs);
  const cacheKey = `weekly-report:${weekEndStr}`;

  if (redisConfigured()) {
    const cached = await redisGetReport(cacheKey).catch(() => null);
    if (cached && cached.report) {
      res.status(200).json({ ...cached, cached: true });
      return;
    }
  }

  try {
    const { statsText, articlesText, postCount } = await buildWeeklyDeltasText(req.headers.host, weekStartMs, weekEndMs);
    const prompt = buildWeeklyReportPrompt(weekStartStr, weekEndStr, statsText, articlesText, buildKbText());
    const { text, blocked } = await callGemini(apiKey, prompt, [{ role: "user", parts: [{ text: "이번 주 리포트를 작성해줘." }] }]);

    const report = text || (blocked ? "이번 주 리포트를 생성할 수 없습니다." : "리포트를 생성하지 못했습니다.");
    const payload = {
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      report,
      statsText,
      postCount,
      generatedAt: new Date().toISOString(),
    };
    if (redisConfigured() && text) await redisSetReport(cacheKey, payload).catch(() => {});
    res.status(200).json({ ...payload, cached: false });
  } catch (err) {
    res.status(502).json({ error: "주간 리포트 생성에 실패했습니다.", detail: String(err.message || err) });
  }
}

function buildSystemPrompt(liveText, articlesText) {
  return `당신은 "bitdash" 비트코인 실시간 대시보드의 질의응답 도우미입니다.

아래 (1) 이 사이트가 다루는 지표·모델에 대한 개념 설명 자료와 (2) 방금 서버에서 가져온 실시간 데이터 스냅샷을 참고해서, 사용자의 질문에 한국어로 답변하세요.

규칙:
- 실시간 데이터 스냅샷의 수치는 최신 값으로 취급해 인용해도 되지만, 최대 10분 전 값일 수 있다는 점을 필요하면 언급하세요.
- University 칼럼 본문에 있는 주장이나 분석을 물어보면, 그 글의 논지를 요약·설명하는 방식으로 답변하세요. 다만 이건 "김대영 비트코인 저널리스트" 개인의 칼럼 의견이지 이 대시보드의 공식 입장이 아니라는 걸 필요하면 밝히세요.
- 이 자료에 없는 내용(개별 알트코인, 특정 종목, 확정적인 매수/매도 추천 등)은 "이 대시보드 자료로는 답하기 어렵습니다"라고 솔직히 말하고 추측을 최소화하세요.
- 답변할 때 관련된 지표나 페이지 이름을 함께 언급하면 좋습니다 (예: "On-Chain 탭의 MVRV Z-Score 참고").
- 투자 손익에 대한 확정적 예측이나 매수/매도 추천은 하지 말고, 지표가 역사적으로 어떻게 해석되어 왔는지 설명하는 방식으로 답변하세요.
- 답변은 간결하고 명확하게, 보통 3~6문장 정도로 작성하세요.

=== 지표/모델 개념 자료 ===
${buildKbText()}

=== 실시간 데이터 스냅샷 ===
${liveText}

=== University 최근 칼럼 본문 (일부 발췌) ===
${articlesText}`;
}

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다." });
    return;
  }

  // GET serves the weekly market report (weekly-report.html); the chat
  // UI in ask.html always POSTs, so there's no ambiguity between the two.
  if (req.method === "GET") {
    await handleWeeklyReport(req, res, apiKey);
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "GET/POST 요청만 지원합니다." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const history = Array.isArray(body.history) ? body.history : [];

  if (!question) {
    res.status(400).json({ error: "질문을 입력해주세요." });
    return;
  }
  if (question.length > MAX_QUESTION_LEN) {
    res.status(400).json({ error: `질문은 ${MAX_QUESTION_LEN}자 이내로 입력해주세요.` });
    return;
  }

  const trimmedHistory = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.slice(0, MAX_QUESTION_LEN) }],
    }));

  const contents = [...trimmedHistory, { role: "user", parts: [{ text: question }] }];

  try {
    const [liveText, articlesText] = await Promise.all([
      buildLiveSnapshot(req.headers.host),
      buildUniversityArticlesText(req.headers.host),
    ]);
    const { text: answer, blocked, truncated } = await callGemini(apiKey, buildSystemPrompt(liveText, articlesText), contents);

    if (!answer) {
      res.status(200).json({
        answer: blocked
          ? "이 질문에는 답변할 수 없습니다. 다른 방식으로 다시 질문해주세요."
          : "답변을 생성하지 못했습니다.",
      });
      return;
    }

    res.status(200).json({
      answer: truncated
        ? answer + '\n\n(※ 답변이 길어져 중간에 잘렸습니다. "이어서 설명해줘"라고 다시 물어보세요.)'
        : answer,
    });
  } catch (err) {
    res.status(err.detail ? 502 : 500).json({
      error: err.detail ? err.message : "요청 처리 중 오류가 발생했습니다.",
      detail: err.detail || String(err.message || err).slice(0, 500),
    });
  }
}
