const NEWS_URL =
  "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC&excludeCategories=Sponsored";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

export default async function handler(req, res) {
  try {
    const upstream = await fetch(NEWS_URL, { headers: HEADERS });
    if (!upstream.ok) {
      res.status(502).json({ error: `Upstream responded ${upstream.status}` });
      return;
    }
    const json = await upstream.json();
    const rows = Array.isArray(json?.Data) ? json.Data : Array.isArray(json) ? json : [];

    const items = rows
      .map((r) => ({
        id: r.id ?? r.guid ?? null,
        title: r.title ?? "",
        url: r.url ?? r.guid ?? null,
        source: r.source_info?.name ?? r.source ?? "Unknown",
        imageUrl: r.imageurl ?? r.imageUrl ?? null,
        body: r.body ?? "",
        publishedAt: r.published_on ? r.published_on * 1000 : r.publishedAt ?? null,
      }))
      .filter((it) => it.title && it.url);

    if (!items.length) {
      res.status(502).json({
        error: "No news items parsed",
        sampleKeys: rows[0] ? Object.keys(rows[0]) : [],
        topLevelKeys: Object.keys(json || {}),
      });
      return;
    }

    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=300");
    res.status(200).json({ fetchedAt: new Date().toISOString(), items });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
