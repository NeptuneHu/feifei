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

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
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
