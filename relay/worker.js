// Bursar reading relay: a Cloudflare Worker that holds one NEAR AI Cloud API key and forwards the three calls the
// console makes (completion, attestation report, signature) without touching the bytes, so the enclave's signature
// over request and response still verifies on the client. It never sees a NEAR key and cannot move funds.
//
// Deploy: wrangler deploy, or paste this file in the Cloudflare dashboard. Secrets and vars: see wrangler.toml.
//
// It also hosts the Telegram inbox: a bot receives invoice PDFs in a chat paired with a treasury, the worker keeps only
// the sender, the file name and Telegram's file reference (the PDF stays on Telegram), and the console lists, fetches,
// reads and discards them. Needs the INBOX KV binding and the TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET secrets.

const UPSTREAM = "https://cloud-api.near.ai";
const MAX_BODY = 2_000_000; // bytes; two invoice pages as PNG fit with room to spare

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

function cors(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const ok = allowed.includes("*") || (origin && allowed.includes(origin));
  return {
    "access-control-allow-origin": ok ? (origin || "*") : "null",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-no-aliasing, authorization",
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

// ---------- Telegram inbox ----------
const TG = (env) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
const INBOX_MAX = 50;
const kvGet = async (env, k) => { const v = await env.INBOX.get(k); return v ? JSON.parse(v) : null; };
const kvPut = (env, k, v, ttl) => env.INBOX.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined);
async function tg(env, method, body) {
  const r = await fetch(`${TG(env)}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
async function botName(env) {
  const cached = await kvGet(env, "bot:me");
  if (cached) return cached;
  const me = await tg(env, "getMe", {});
  await kvPut(env, "bot:me", me.username, 86400);
  return me.username;
}
const authed = async (env, request, treasury) => {
  const t = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const rec = treasury && await kvGet(env, `treasury:${treasury}`);
  return rec && t && rec.token === t ? rec : null;
};
const newCode = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.getRandomValues(new Uint8Array(8)); return Array.from(b, (x) => a[x % 32]).join(""); };

/** One Telegram update: /start <code> pairs the chat with a treasury; a PDF in a paired chat lands in that treasury's inbox. */
async function onUpdate(env, update) {
  const m = update.message || update.channel_post;
  if (!m) return;
  const chat = m.chat.id;
  const say = (text) => tg(env, "sendMessage", { chat_id: chat, text, disable_web_page_preview: true }).catch(() => {});
  const text = (m.text || "").trim();
  if (/^\/start/.test(text)) {
    const code = text.split(/\s+/)[1];
    const pair = code && await kvGet(env, `pair:${code.toUpperCase()}`);
    if (!pair) return say("Bursar inbox. To connect this chat to a company's treasury, open the Bursar console, Settings, Connect Telegram, and use the link it gives you.");
    const rec = (await kvGet(env, `treasury:${pair.treasury}`)) || { token: pair.token, chats: [] };
    if (!rec.chats.includes(chat)) rec.chats.push(chat);
    rec.label = pair.label || rec.label;
    await Promise.all([kvPut(env, `treasury:${pair.treasury}`, rec), kvPut(env, `tg:${chat}`, { treasury: pair.treasury, label: pair.for || "" }), env.INBOX.delete(`pair:${code.toUpperCase()}`)]);
    return say(`Connected to ${rec.label || pair.treasury}${pair.for ? ` as ${pair.for}` : ""}. Send invoices here as PDF: they land in the company's inbox, a person reads them in the console, and the treasury contract decides. Nothing is paid from this chat.`);
  }
  const doc = m.document;
  if (!doc) { if (text) await say("Send the invoice as a PDF file. Photos and text are not read."); return; }
  const link = await kvGet(env, `tg:${chat}`);
  if (!link) return say("This chat is not connected to a treasury yet. Open the Bursar console, Settings, Connect Telegram.");
  const name = doc.file_name || "invoice.pdf";
  if (!(doc.mime_type === "application/pdf" || /\.pdf$/i.test(name))) return say(`${name}: only PDF invoices are read.`);
  if (doc.file_size > MAX_BODY) return say(`${name} is over 2 MB; send a smaller PDF.`);
  const items = (await kvGet(env, `inbox:${link.treasury}`)) || [];
  const from = m.from ? [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") + (m.from.username ? ` (@${m.from.username})` : "") : (m.chat.title || "channel");
  items.push({ id: `${m.message_id}-${chat}`, file_id: doc.file_id, name, size: doc.file_size || 0, from, chat, chat_title: link.label || m.chat.title || null, caption: m.caption || "", date: (m.date || Math.floor(Date.now() / 1000)) * 1000 });
  while (items.length > INBOX_MAX) items.shift();
  await kvPut(env, `inbox:${link.treasury}`, items);
  await say(`Received ${name}. It waits in the inbox; a person will read it and the contract will decide.`);
}

async function inbox(request, env, url, headers) {
  const p = url.pathname;
  if (!env.INBOX || !env.TELEGRAM_BOT_TOKEN) return json(503, { error: "the Telegram inbox is not configured on this relay (INBOX binding and TELEGRAM_BOT_TOKEN)" }, headers);
  // Telegram calls this one; the secret header proves it is Telegram.
  if (request.method === "POST" && p === "/tg/webhook") {
    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return json(403, { error: "bad secret" });
    try { await onUpdate(env, await request.json()); } catch (e) { console.log("webhook", e.message); }
    return json(200, { ok: true });
  }
  // One-time setup from the browser: registers this worker's URL with Telegram. Protected by the webhook secret.
  if (request.method === "GET" && p === "/tg/setup") {
    if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get("secret") !== env.TELEGRAM_WEBHOOK_SECRET) return json(403, { error: "bad secret" }, headers);
    const r = await tg(env, "setWebhook", { url: `${url.origin}/tg/webhook`, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "channel_post"] });
    return json(200, { ok: true, webhook: `${url.origin}/tg/webhook`, bot: await botName(env), result: r }, headers);
  }
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const treasury = body.treasury || url.searchParams.get("treasury");
  if (!treasury) return json(400, { error: "treasury is required" }, headers);
  // Pairing: the console picks a token for the treasury and gets a code the chat sends to the bot.
  if (request.method === "POST" && p === "/inbox/pair") {
    if (!body.token || body.token.length < 16) return json(400, { error: "token is required" }, headers);
    const rec = await kvGet(env, `treasury:${treasury}`);
    if (rec && rec.token !== body.token) return json(403, { error: "this treasury is already connected from another browser; its token is needed" }, headers);
    if (!rec) await kvPut(env, `treasury:${treasury}`, { token: body.token, chats: [], label: body.label || "" });
    else if (body.label && body.label !== rec.label) { rec.label = body.label; await kvPut(env, `treasury:${treasury}`, rec); }
    const code = newCode();
    await kvPut(env, `pair:${code}`, { treasury, token: body.token, label: body.label || "", for: String(body.for || "").slice(0, 60) }, 86400);
    const bot = await botName(env);
    return json(200, { code, bot, link: `https://t.me/${bot}?start=${code}` }, headers);
  }
  const rec = await authed(env, request, treasury);
  if (!rec) return json(401, { error: "bad or missing inbox token" }, headers);
  if (request.method === "GET" && p === "/inbox/list") {
    const items = (await kvGet(env, `inbox:${treasury}`)) || [];
    return json(200, { items: items.map(({ file_id, ...x }) => x), chats: rec.chats.length, bot: await botName(env) }, headers);
  }
  if (request.method === "GET" && p === "/inbox/file") {
    const items = (await kvGet(env, `inbox:${treasury}`)) || [];
    const it = items.find((x) => x.id === url.searchParams.get("id"));
    if (!it) return json(404, { error: "no such item" }, headers);
    const f = await tg(env, "getFile", { file_id: it.file_id });
    const up = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
    if (!up.ok) return json(502, { error: `telegram file ${up.status}` }, headers);
    return new Response(up.body, { status: 200, headers: { ...headers, "content-type": "application/pdf", "content-disposition": `inline; filename="${it.name.replace(/[^\w.-]/g, "_")}"` } });
  }
  if (request.method === "POST" && p === "/inbox/discard") {
    const items = (await kvGet(env, `inbox:${treasury}`)) || [];
    await kvPut(env, `inbox:${treasury}`, items.filter((x) => x.id !== body.id));
    return json(200, { ok: true }, headers);
  }
  // The outcome goes back to the chat the invoice came from (body.chat), so one vendor never sees another's decisions;
  // without a chat it goes to every connected chat (the company's own channels).
  if (request.method === "POST" && p === "/inbox/notify") {
    const text = String(body.text || "").slice(0, 1000);
    if (!text) return json(400, { error: "text is required" }, headers);
    const targets = body.chat != null ? rec.chats.filter((c) => String(c) === String(body.chat)) : rec.chats;
    await Promise.all(targets.map((c) => tg(env, "sendMessage", { chat_id: c, text, disable_web_page_preview: true }).catch(() => {})));
    return json(200, { ok: true, chats: targets.length }, headers);
  }
  return json(404, { error: "not found" }, headers);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const headers = cors(env, origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (url.pathname.startsWith("/tg/") || url.pathname.startsWith("/inbox/")) return inbox(request, env, url, headers);
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
    if (request.method === "GET" && url.pathname === "/") return json(200, { relay: "bursar", upstream: UPSTREAM, routes: ["POST /v1/chat/completions", "GET /v1/attestation/report", "GET /v1/signature/{id}", "GET /pccs/{intel collateral path}", "POST /tg/webhook", "POST /inbox/pair", "GET /inbox/list", "GET /inbox/file", "POST /inbox/discard", "POST /inbox/notify"], telegram: !!(env.INBOX && env.TELEGRAM_BOT_TOKEN) }, headers);
    return json(404, { error: "not found" }, headers);
  },
};
