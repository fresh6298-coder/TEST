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
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST 요청만 지원합니다." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다." });
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
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: buildSystemPrompt(liveText, articlesText) }] },
          contents,
          generationConfig: {
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(502).json({ error: "AI 응답 생성에 실패했습니다.", detail: errText.slice(0, 500) });
      return;
    }

    const data = await upstream.json();
    const candidate = (data.candidates || [])[0];
    const answer = ((candidate && candidate.content && candidate.content.parts) || [])
      .map((part) => part.text || "")
      .join("\n")
      .trim();

    if (!answer) {
      const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
      res.status(200).json({
        answer: blockReason
          ? "이 질문에는 답변할 수 없습니다. 다른 방식으로 다시 질문해주세요."
          : "답변을 생성하지 못했습니다.",
      });
      return;
    }

    const truncated = candidate && candidate.finishReason === "MAX_TOKENS";
    res.status(200).json({
      answer: truncated
        ? answer + '\n\n(※ 답변이 길어져 중간에 잘렸습니다. "이어서 설명해줘"라고 다시 물어보세요.)'
        : answer,
    });
  } catch (err) {
    res.status(500).json({ error: "요청 처리 중 오류가 발생했습니다.", detail: String(err).slice(0, 500) });
  }
}
