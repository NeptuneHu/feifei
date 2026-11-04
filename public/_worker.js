const ALLOW = {
  "sh1:000001": "https://yunhq.sse.com.cn:32042/v1/sh1/snap/000001",
  "sz1:399001": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399001",
  "sz1:399006": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399006",
  "csi:931071": "https://yunhq.sse.com.cn:32042/v1/csi/snap/931071",
  "sz1:399363": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399363",
  "sz1:399997": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399997",
  "csi:931238": "https://yunhq.sse.com.cn:32042/v1/csi/snap/931238",
  "sz1:980017": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/980017"
};

const FLASH = "https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=20&req_trace=1710315450384";

function json(body, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache
    }
  });
}

function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function snap(url) {
  const target = ALLOW[`${url.searchParams.get("channel")}:${url.searchParams.get("code")}`];
  if (!target) return new Response("no", {status: 404});
  const upstreamUrl = new URL(target);
  upstreamUrl.searchParams.set('_', Date.now().toString());
  const upstream = await fetch(upstreamUrl.toString(), {
    headers: {"user-agent": "Mozilla/5.0 (compatible; FeifeiBrief/0.3)", "cache-control": "no-cache"},
    cf: {cacheTtl: 0, cacheEverything: false},
    signal: AbortSignal.timeout(6500)
  });
  if (!upstream.ok) return new Response("upstream", {status: 502});
  return new Response(await upstream.text(), {
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}
  });
}

async function brief() {
  const upstream = await fetch(FLASH, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; FeifeiBrief/0.3)",
      "referer": "https://kuaixun.eastmoney.com/"
    }
  });
  if (!upstream.ok) return json({ok: false, items: []}, 502);
  const data = await upstream.json();
  const list = Array.isArray(data?.data?.fastNewsList) ? data.data.fastNewsList : [];
  const items = [];
  for (const row of list) {
    const title = String(row?.title || "").trim();
    const summary = String(row?.summary || "").trim();
    const code = String(row?.code || "").trim();
    if (!title && !summary) continue;
    items.push({
      title,
      summary,
      published_at: String(row?.showTime || "").trim(),
      url: /^\d+$/.test(code) ? `https://finance.eastmoney.com/a/${code}.html` : ""
    });
    if (items.length >= 7) break;
  }
  if (!items.length) return json({ok: false, items: []}, 502);
  return json({
    ok: true,
    fetched_on: shanghaiToday(),
    as_of: new Date().toISOString(),
    from_cache: false,
    items
  }, 200, "public, max-age=600");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/snap") return snap(url).catch(() => json({error: "行情暂不可用"}, 502));
    if (url.pathname === "/api/brief") return brief();
    return env.ASSETS.fetch(request);
  }
};
