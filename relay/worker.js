// Bursar reading relay: a Cloudflare Worker that holds one NEAR AI Cloud API key and forwards the three calls the
// console makes (completion, attestation report, signature) without touching the bytes, so the enclave's signature
// over request and response still verifies on the client. It never sees a NEAR key and cannot move funds.
//
// Deploy: wrangler deploy, or paste this file in the Cloudflare dashboard. Secrets and vars: see wrangler.toml.

const UPSTREAM = "https://cloud-api.near.ai";
const MAX_BODY = 2_000_000; // bytes; two invoice pages as PNG fit with room to spare

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

function cors(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const ok = allowed.includes("*") || (origin && allowed.includes(origin));
  return {
    "access-control-allow-origin": ok ? (origin || "*") : "null",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-no-aliasing",
    "access-control-expose-headers": "*",
    "vary": "origin",
  };
}

/** Daily counters in KV when the LIMITS binding exists; without it the relay still works, just without caps. */
async function underLimits(env, ip) {
  if (!env.LIMITS) return { ok: true };
  const day = new Date().toISOString().slice(0, 10);
  const perIp = Number(env.MAX_READS_PER_IP_PER_DAY || 20), global = Number(env.MAX_READS_PER_DAY || 300);
  const [ipCount, allCount] = await Promise.all([env.LIMITS.get(`ip:${day}:${ip}`), env.LIMITS.get(`all:${day}`)]);
  if (Number(ipCount || 0) >= perIp) return { ok: false, why: "daily limit for this address reached; use your own NEAR AI Cloud key" };
  if (Number(allCount || 0) >= global) return { ok: false, why: "the relay's daily budget is spent; use your own NEAR AI Cloud key" };
  const ttl = 172800;
  await Promise.all([env.LIMITS.put(`ip:${day}:${ip}`, String(Number(ipCount || 0) + 1), { expirationTtl: ttl }), env.LIMITS.put(`all:${day}`, String(Number(allCount || 0) + 1), { expirationTtl: ttl })]);
  return { ok: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const headers = cors(env, origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (!env.NEAR_AI_API_KEY) return json(500, { error: "NEAR_AI_API_KEY is not set on the relay" }, headers);
    const auth = { Authorization: `Bearer ${env.NEAR_AI_API_KEY}`, "x-no-aliasing": "true" };
    const ip = request.headers.get("cf-connecting-ip") || "unknown";

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY) return json(413, { error: `request body over ${MAX_BODY} bytes` }, headers);
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { return json(400, { error: "body is not JSON" }, headers); }
      const models = (env.ALLOWED_MODELS || "z-ai/glm-5.3-flash").split(",").map((s) => s.trim());
      if (!models.includes(parsed.model)) return json(400, { error: `model not allowed by this relay: ${parsed.model}` }, headers);
      if (parsed.stream) return json(400, { error: "streaming is not relayed: the signature needs the whole response" }, headers);
      const lim = await underLimits(env, ip);
      if (!lim.ok) return json(429, { error: lim.why }, headers);
      // Forward the exact bytes: the enclave signs sha256(request) and sha256(response).
      const up = await fetch(`${UPSTREAM}/v1/chat/completions`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body });
      return new Response(up.body, { status: up.status, headers: { ...headers, "content-type": up.headers.get("content-type") || "application/json" } });
    }
    if (request.method === "GET" && url.pathname === "/v1/attestation/report") {
      const up = await fetch(`${UPSTREAM}/v1/attestation/report${url.search}`, { headers: auth });
      return new Response(up.body, { status: up.status, headers: { ...headers, "content-type": up.headers.get("content-type") || "application/json" } });
    }
    if (request.method === "GET" && /^\/v1\/signature\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      const up = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, { headers: auth });
      return new Response(up.body, { status: up.status, headers: { ...headers, "content-type": up.headers.get("content-type") || "application/json" } });
    }
    // Intel collateral for the TDX quote check, from Phala's PCCS mirror. Headers carry the issuer chains, so they are copied too.
    if (request.method === "GET" && url.pathname.startsWith("/pccs/")) {
      const up = await fetch(`https://pccs.phala.network${url.pathname.slice(5)}${url.search}`);
      const h = new Headers(headers);
      for (const [k, v] of up.headers) if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) h.set(k, v);
      return new Response(up.body, { status: up.status, headers: h });
    }
    if (request.method === "GET" && url.pathname === "/") return json(200, { relay: "bursar", upstream: UPSTREAM, routes: ["POST /v1/chat/completions", "GET /v1/attestation/report", "GET /v1/signature/{id}", "GET /pccs/{intel collateral path}"] }, headers);
    return json(404, { error: "not found" }, headers);
  },
};
