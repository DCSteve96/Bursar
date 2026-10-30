// Bursar reading relay: a Cloudflare Worker that holds one NEAR AI Cloud API key and forwards the three calls the
// console makes (completion, attestation report, signature) without touching the bytes, so the enclave's signature
// over request and response still verifies on the client. It never sees a NEAR key and cannot move funds.
//
// Deploy: wrangler deploy, or paste this file in the Cloudflare dashboard. Secrets and vars: see wrangler.toml.
//
// It also hosts the Telegram inbox: a bot receives invoice PDFs in a chat paired with a treasury, the worker keeps only
// the sender, the file name and Telegram's file reference (the PDF stays on Telegram), and the console lists, fetches,
// reads and discards them. The owner's own chat can be paired as approver: each invoice is forwarded there with Approve
// and Reject, an approved one is read and submitted by the agent (bursar agent), and the outcome comes back to the chat. Needs the INBOX KV binding and the TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET secrets.

const UPSTREAM = "https://cloud-api.near.ai";
const MAX_BODY = 2_000_000; // bytes; two invoice pages as PNG fit with room to spare

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

function cors(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const ok = allowed.includes("*") || (origin && allowed.some((a) => a === origin || (a.startsWith("*.") && origin.endsWith(a.slice(1)) && origin.startsWith("https://"))));
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
const PER_CHAT_MAX = 10;
const TAKE_TTL = 10 * 60 * 1000; // an approved invoice the agent took but never reported is offered again after this
const FOLLOW_TTL = 60 * 86400; // seconds a held or queued invoice stays known by payment id, for the outcome that comes later
const FINAL = new Set(["Paid", "Blocked", "Cancelled", "Settled", "rejected", "discarded", "error"]);
const CONSOLE = (env) => (env.CONSOLE_URL || "https://bursar.network/console").replace(/\/$/, "");
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
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58decode = (str) => { let n = 0n; for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.push(Number(n % 256n)); n /= 256n; } for (const c of str) { if (c !== "1") break; out.push(0); } return new Uint8Array(out.reverse()); };
const hexBytes = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
const sha256hex = async (str) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str))), (b) => b.toString(16).padStart(2, "0")).join("");
const RPC = { testnet: "https://test.rpc.fastnear.com", mainnet: "https://free.rpc.fastnear.com" };
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
async function rpc(network, params) {
  const r = await fetch(RPC[network], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.data || j.error.message || "rpc error");
  return j.result;
}
const nearView = async (network, account, method, args = {}) => { const r = await rpc(network, { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) }); return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))); };
/** The pairing of a treasury is signed by its owner: the owner from `get_roles`, a key that is on the owner's account, a fresh timestamp. */
async function ownerProof(body) {
  const { network, treasury, token, owner, pubkey, ts, sig } = body;
  if (!(network in RPC)) return "network must be testnet or mainnet";
  if (typeof treasury !== "string" || treasury.length > 64 || !ACCOUNT_RE.test(treasury)) return "bad treasury id";
  if (typeof owner !== "string" || owner.length > 64 || !ACCOUNT_RE.test(owner)) return "bad owner id";
  if (typeof pubkey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(pubkey)) return "bad public key";
  if (typeof ts !== "number" || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return "the signature is not fresh";
  if (typeof sig !== "string" || !/^[0-9a-f]{128}$/.test(sig)) return "bad signature";
  let roles; try { roles = await nearView(network, treasury, "get_roles"); } catch (e) { return `cannot read the treasury: ${e.message}`; }
  if (!Array.isArray(roles) || roles[0] !== owner) return "that account does not own this treasury";
  try { await rpc(network, { request_type: "view_access_key", finality: "final", account_id: owner, public_key: pubkey }); } catch { return "that key is not on the owner's account"; }
  const msg = new TextEncoder().encode(`bursar-inbox-pair\n${treasury}\n${await sha256hex(token)}\n${ts}`);
  try {
    const key = await crypto.subtle.importKey("raw", b58decode(pubkey.slice(8)), { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, hexBytes(sig), msg))) return "the signature does not verify";
  } catch (e) { return `the signature cannot be checked: ${e.message}`; }
  return null;
}
const newCode = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.getRandomValues(new Uint8Array(8)); return Array.from(b, (x) => a[x % 32]).join(""); };
const personName = (u) => u ? [u.first_name, u.last_name].filter(Boolean).join(" ") + (u.username ? ` (@${u.username})` : "") : "";
const isApprover = (rec, chat) => !!rec.approvers?.[String(chat)];
/** The invoices still waiting for a decision that were put in front of this approver chat. */
async function waitingFor(env, treasury, chat) {
  const items = (await kvGet(env, `inbox:${treasury}`)) || [];
  return items.filter((x) => (x.status || "waiting") === "waiting" && x.asked?.[String(chat)]);
}
const stripItem = ({ file_id, asked, ...x }) => ({ ...x, status: x.status || "waiting" });

// The contract's reasons, in words. Same texts as the console.
const REASON = {
  payout_changed: "payout on the invoice differs from the vendor record: the new bank details fraud", duplicate_invoice: "same vendor and invoice number already accepted",
  unknown_vendor: "vendor not in the allowlist", vendor_inactive: "vendor deactivated by the owner", over_payment_cap: "above the per-payment cap", over_monthly_budget: "vendor monthly budget exceeded",
  over_daily_cap: "daily cap exceeded", insufficient_treasury: "not enough USDC in the treasury", zero_amount: "zero amount", paused: "treasury paused",
  dao_proposal_failed: "the DAO refused to open the proposal; budget released", transfer_failed: "USDC transfer failed on the token contract; balance restored",
  hold_quota_reached: "the agent already put its daily quota of invoices in front of a person", dao_bond_missing: "the treasury account has no NEAR left for the DAO proposal bond",
  no_invoice_identity: "no invoice number and no file hash: nothing to tell it apart from another invoice",
};
const HOLD = {
  payout_unconfirmed: "an operator recorded this vendor's payout and the owner has not confirmed it", many_invoices: "this vendor already had its daily allowance of invoices paid without a person",
  over_threshold: "amount at or above the approval threshold", no_order: "no purchase order or standing order covers it", flagged: "the invoice carries flags",
  identity_mismatch: "the vendor's tax id on the invoice is not the one recorded", buyer_mismatch: "the invoice is not addressed to the company's tax id", withholding_mismatch: "the withholding shown differs from what the accountant set",
};
const holdText = (r) => (r || "over_threshold").split("+").map((x) => HOLD[x] ?? x).join(", ");

/** What the approver reads when an invoice is decided (by the contract, by the agent, or in the console). */
function approverText(env, treasury, it, o) {
  const head = [o.invoice_number || it.name, o.vendor, o.amount].filter(Boolean).join(", ");
  const tx = o.tx_url ? `\n${o.tx_url}` : "";
  switch (o.status) {
    case "Paid": return `Paid: ${head}.${tx}`;
    case "Queued": case "Settling": return `Queued: ${head}. The vendor is paid on another chain; the executor settles it.${tx}`;
    case "Settled": return `Settled: ${head}.${tx}`;
    case "Approval": return `Held: ${head}.\nReason: ${holdText(o.reason)}.\nOpen the console to review it and approve with your wallet: ${CONSOLE(env)}?treasury=${encodeURIComponent(treasury)}#attention`;
    case "Blocked": return `Blocked: ${head}.\nReason: ${REASON[o.reason] ?? o.reason ?? "refused by the contract"}.${tx}`;
    case "Cancelled": return `Cancelled: ${head}.${tx}`;
    case "error": return `Not sent: ${it.name}. ${o.message || "the agent could not read it"}. Open the console to read it yourself: ${CONSOLE(env)}?treasury=${encodeURIComponent(treasury)}#inbox`;
    case "rejected": return `Rejected by ${o.by || "the approver"}: ${it.name}.`;
    case "discarded": return `Discarded in the console: ${it.name}.`;
    default: return `${o.status}: ${head}.${tx}`;
  }
}
/** What the chat the invoice came from reads: the outcome, never the company's reasons. */
function vendorText(it, o) {
  switch (o.status) {
    case "Paid": return `${it.name}: paid.${o.tx_url ? `\n${o.tx_url}` : ""}`;
    case "Queued": case "Settling": case "Settled": return `${it.name}: approved, settlement in progress.`;
    case "Approval": return `${it.name}: under review at the company.`;
    case "Blocked": case "Cancelled": case "rejected": return `${it.name}: declined.`;
    case "error": return `${it.name}: could not be read automatically; the company was told.`;
    default: return "";
  }
}
/** Tell every approver chat, under the message that asked for the decision when there is one, and drop its buttons. */
async function tellApprovers(env, rec, it, text) {
  await Promise.all(Object.keys(rec.approvers || {}).map(async (chat) => {
    const mid = it.asked?.[chat];
    if (mid) await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await tg(env, "sendMessage", { chat_id: chat, text, disable_web_page_preview: true, ...(mid ? { reply_to_message_id: mid } : {}) }).catch(() => {});
  }));
}
/** A new invoice: every approver gets it with the PDF attached (Telegram re-sends its own file, nothing is uploaded) and two buttons. */
async function askApprovers(env, rec, it, link) {
  it.asked = {};
  const auto = it.status === "approved";
  const text = `New invoice from ${it.from}${it.chat_title ? ` (${it.chat_title})` : ""}${it.vendor ? `, expected from ${link.label || it.vendor}` : ""}.\n${it.name}, ${Math.max(1, Math.round(it.size / 1024))} KB${it.caption ? `\nNote: ${it.caption}` : ""}\n\n${auto ? "Accepted without asking: this chat is a trusted vendor. Bursar reads it in the enclave and the treasury contract decides within your limits; the outcome follows here." : "Approve: Bursar reads it in the enclave and the treasury contract decides within your limits. Reject: it is declined."}`;
  const reply_markup = auto ? undefined : { inline_keyboard: [[{ text: "Approve", callback_data: `a:${it.id}` }, { text: "Reject", callback_data: `r:${it.id}` }]] };
  for (const chat of Object.keys(rec.approvers || {})) {
    try {
      const sent = String(chat) === String(it.chat)
        ? await tg(env, "sendMessage", { chat_id: chat, text, reply_to_message_id: it.message_id, reply_markup })
        : await tg(env, "sendDocument", { chat_id: chat, document: it.file_id, caption: text, reply_markup });
      it.asked[chat] = sent.message_id;
    } catch (e) { console.log("ask", e.message); }
  }
}
/** The approver's decision on one inbox item. Approve marks it for the agent; reject drops it and tells the vendor. */
async function decide(env, treasury, id, approve, who) {
  const rec = await kvGet(env, `treasury:${treasury}`);
  const items = (await kvGet(env, `inbox:${treasury}`)) || [];
  const it = items.find((x) => x.id === id);
  if (!rec || !it) return "This invoice is no longer waiting.";
  if (it.status === "approved" || it.status === "reading") return "Already approved; the agent is on it.";
  if (approve) {
    it.status = "approved"; it.approved_by = who; it.approved_at = Date.now();
    await kvPut(env, `inbox:${treasury}`, items);
    await tellApprovers(env, rec, it, `Approved by ${who}. Bursar reads it in the enclave and the contract decides; the outcome follows here.`);
    if (!isApprover(rec, it.chat)) await tg(env, "sendMessage", { chat_id: it.chat, text: `${it.name}: accepted by the company, being processed.` }).catch(() => {});
    return "Approved. The outcome follows here.";
  }
  await kvPut(env, `inbox:${treasury}`, items.filter((x) => x.id !== id));
  await tellApprovers(env, rec, it, approverText(env, treasury, it, { status: "rejected", by: who }));
  if (!isApprover(rec, it.chat)) await tg(env, "sendMessage", { chat_id: it.chat, text: vendorText(it, { status: "rejected" }) }).catch(() => {});
  return "Rejected.";
}

/** A button pressed under a forwarded invoice: only the person who connected the chat as approver counts. */
async function onCallback(env, cq) {
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});
  const chat = cq.message?.chat?.id;
  const [verb, id] = String(cq.data || "").split(":");
  const link = chat != null && await kvGet(env, `tg:${chat}`);
  if (!link || !link.approver || !["a", "r", "aa", "ak"].includes(verb) || (verb.length === 1 && !id)) return answer("Not for this chat.");
  if (String(cq.from?.id) !== String(link.user)) return answer("Only the person who connected this chat as approver decides here.");
  if (verb === "aa" || verb === "ak") {
    // "Approve all" under the summary this chat asked for: every invoice still waiting here, in one go
    await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: cq.message?.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (verb === "ak") return answer("Kept waiting.");
    const waiting = await waitingFor(env, link.treasury, chat);
    let n = 0;
    for (const it of waiting) if (/^Approved\./.test(await decide(env, link.treasury, it.id, true, personName(cq.from)))) n++;
    return answer(n ? `Approved ${n}. The outcomes follow here.` : "Nothing was waiting any more.");
  }
  return answer(await decide(env, link.treasury, id, verb === "a", personName(cq.from)));
}

/** One Telegram update: /start <code> pairs the chat with a treasury; a PDF in a paired chat lands in that treasury's inbox;
 *  in an approver's chat, a button or a yes/no decides a waiting invoice. */
async function onUpdate(env, update) {
  if (update.callback_query) return onCallback(env, update.callback_query);
  const m = update.message || update.channel_post;
  if (!m) return;
  const chat = m.chat.id;
  const say = (text) => tg(env, "sendMessage", { chat_id: chat, text, disable_web_page_preview: true }).catch(() => {});
  const text = (m.text || "").trim();
  const title = m.chat.title || personName(m.from);
  if (/^\/start/.test(text)) {
    const code = text.split(/\s+/)[1];
    const pair = code && await kvGet(env, `pair:${code.toUpperCase()}`);
    if (!pair) return say("Bursar inbox. To connect this chat to a company's treasury, open the Bursar console, Settings, Connect Telegram, and use the link it gives you.");
    const already = await kvGet(env, `tg:${chat}`);
    if (already && already.treasury !== pair.treasury) return say("This chat is already connected to another company. Disconnect it from that company's console first.");
    const rec = (await kvGet(env, `treasury:${pair.treasury}`)) || { token: pair.token, chats: [] };
    if (!rec.chats.includes(chat)) rec.chats.push(chat);
    rec.label = pair.label || rec.label;
    // what the company knows about this chat: the vendor it is for (a vendor id on the contract), a label, the chat's own title
    rec.chatInfo = rec.chatInfo || {};
    if (pair.approver) {
      // the person who pressed Start is the approver: in a group, nobody else's buttons count
      rec.approvers = rec.approvers || {};
      rec.approvers[String(chat)] = { user: m.from?.id ?? chat, name: personName(m.from), since: Date.now() };
      rec.chatInfo[chat] = { label: "approver", vendor: "", title, since: Date.now(), approver: true };
      await Promise.all([kvPut(env, `treasury:${pair.treasury}`, rec), kvPut(env, `tg:${chat}`, { treasury: pair.treasury, label: "", vendor: "", approver: true, user: m.from?.id ?? chat }), env.INBOX.delete(`pair:${code.toUpperCase()}`)]);
      return say(`You approve invoices for ${rec.label || pair.treasury} from here. Every invoice that reaches the inbox is forwarded to you with Approve and Reject; when several wait, reply to the one you mean. Approve means Bursar reads it in the enclave and the treasury contract decides within the limits you set: nothing here can move funds past them, and an invoice the contract holds is approved in the console, with your wallet. PDFs you send here land in the inbox too.`);
    }
    const auto = !!(pair.auto && pair.vendor);
    rec.chatInfo[chat] = { label: pair.for || "", vendor: pair.vendor || "", title, since: Date.now(), auto };
    await Promise.all([kvPut(env, `treasury:${pair.treasury}`, rec), kvPut(env, `tg:${chat}`, { treasury: pair.treasury, label: pair.for || "", vendor: pair.vendor || "", auto }), env.INBOX.delete(`pair:${code.toUpperCase()}`)]);
    return say(`Connected to ${rec.label || pair.treasury}${pair.vendor ? ` for the vendor ${pair.for || pair.vendor}: invoices from here are expected from that vendor, any other name is held for a person` : pair.for ? ` as ${pair.for}` : ""}. Send invoices here as PDF: ${auto ? "they go straight to the treasury contract, which decides within the company's limits, and the outcome comes back here" : "they land in the company's inbox, a person reads them in the console, and the treasury contract decides"}. Nothing is paid from this chat.`);
  }
  if (/^\/privacy\b/.test(text)) return say(`Bursar keeps, for each invoice, the sender's Telegram name, the chat, the file name and Telegram's file reference; the PDF stays on Telegram until a person reads it. Entries are deleted once the invoice is decided. The bot holds no keys and pays nothing. Full notice: ${CONSOLE(env).replace(/\/console$/, "")}/privacy`);
  if (/^\/help\b/.test(text)) return say("Bursar inbox. A company connects this chat from its console; PDF invoices posted here reach the company, a person reads them and the treasury contract decides. An approver connected from the console gets each invoice with Approve and Reject. Nothing is paid from this chat. /privacy for what is kept.");
  const link = await kvGet(env, `tg:${chat}`);
  const doc = m.document;
  // an approver asking for everything at once: a summary first, then one button for all of it
  if (!doc && link?.approver && /^(\/all\b|approve all\b|yes all\b|all\b)/i.test(text)) {
    if (String(m.from?.id) !== String(link.user)) return say("Only the person who connected this chat as approver decides here.");
    const waiting = await waitingFor(env, link.treasury, chat);
    if (!waiting.length) return say("Nothing is waiting for a decision.");
    const lines = waiting.map((it, i) => `${i + 1}. ${it.name}, from ${it.from}${it.vendor ? ` (${it.chat_title || it.vendor})` : ""}${it.caption ? `: ${it.caption.slice(0, 60)}` : ""}`);
    return tg(env, "sendMessage", { chat_id: chat, text: `${waiting.length} invoice${waiting.length === 1 ? "" : "s"} waiting:\n${lines.join("\n")}\n\nApprove all means Bursar reads each one in the enclave and the contract decides each on its own limits; what the contract holds comes back here.`, reply_markup: { inline_keyboard: [[{ text: `Approve all ${waiting.length}`, callback_data: "aa" }, { text: "Keep waiting", callback_data: "ak" }]] } }).catch(() => {});
  }
  // an approver writing yes or no: the invoice they replied to, or the only one waiting
  if (!doc && text && link?.approver) {
    const yes = /^(yes|y|ok|okay|approve|approved|pay)\b/i.test(text), no = /^(no|reject|rejected|decline|declined|cancel)\b/i.test(text);
    if (yes || no) {
      if (String(m.from?.id) !== String(link.user)) return say("Only the person who connected this chat as approver decides here.");
      const items = (await kvGet(env, `inbox:${link.treasury}`)) || [];
      const rid = m.reply_to_message?.message_id;
      const waiting = items.filter((x) => (x.status || "waiting") === "waiting" && x.asked?.[String(chat)]);
      const it = rid ? items.find((x) => x.asked?.[String(chat)] === rid) : waiting.length === 1 ? waiting[0] : null;
      if (!it) return say(rid ? "That message is not an invoice waiting for a decision." : waiting.length ? `${waiting.length} invoices are waiting: reply to the one you mean, or use its buttons.` : "Nothing is waiting for a decision.");
      const note = await decide(env, link.treasury, it.id, yes, personName(m.from));
      return /^(Approved|Rejected)\./.test(note) ? undefined : say(note); // the decision itself is already posted under the invoice
    }
  }
  if (!doc) { if (text) await say("Send the invoice as a PDF file. Photos and text are not read."); return; }
  if (!link) return say("This chat is not connected to a treasury yet. Open the Bursar console, Settings, Connect Telegram.");
  const name = doc.file_name || "invoice.pdf";
  if (!(doc.mime_type === "application/pdf" || /\.pdf$/i.test(name))) return say(`${name}: only PDF invoices are read.`);
  if (doc.file_size > MAX_BODY) return say(`${name} is over 2 MB; send a smaller PDF.`);
  const rec = (await kvGet(env, `treasury:${link.treasury}`)) || { chats: [] };
  const items = (await kvGet(env, `inbox:${link.treasury}`)) || [];
  // one chat cannot push the other vendors' invoices out of the inbox
  if (items.filter((x) => String(x.chat) === String(chat)).length >= PER_CHAT_MAX) return say(`${name}: this chat already has ${PER_CHAT_MAX} invoices waiting. Send the next one once they are decided.`);
  const from = m.from ? personName(m.from) : (m.chat.title || "channel");
  // a trusted vendor's chat: no question to the approver, the invoice is queued as accepted and the contract still decides
  const auto = !!(link.auto && link.vendor);
  const it = { id: `${m.message_id}-${chat}`, message_id: m.message_id, file_id: doc.file_id, name, size: doc.file_size || 0, from, chat, chat_title: link.label || m.chat.title || null, vendor: link.vendor || "", caption: m.caption || "", date: (m.date || Math.floor(Date.now() / 1000)) * 1000, status: auto ? "approved" : "waiting", ...(auto ? { approved_by: "trusted vendor (no question asked)", approved_at: Date.now() } : {}) };
  await askApprovers(env, rec, it, link);
  items.push(it);
  while (items.length > INBOX_MAX) items.shift();
  await kvPut(env, `inbox:${link.treasury}`, items);
  await say(link.approver ? `Received ${name}. Approve or reject it above.` : auto ? `Received ${name}. Accepted: the treasury contract decides next, and the outcome comes back here.` : `Received ${name}. It waits in the inbox; a person will read it and the contract will decide.`);
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
    const r = await tg(env, "setWebhook", { url: `${url.origin}/tg/webhook`, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "channel_post", "callback_query"] });
    return json(200, { ok: true, webhook: `${url.origin}/tg/webhook`, bot: await botName(env), result: r }, headers);
  }
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const treasury = body.treasury || url.searchParams.get("treasury");
  if (!treasury) return json(400, { error: "treasury is required" }, headers);
  // Pairing: the console picks a token for the treasury and gets a code the chat sends to the bot. `approver: true` pairs the owner's own chat.
  if (request.method === "POST" && p === "/inbox/pair") {
    if (typeof body.token !== "string" || body.token.length < 16 || body.token.length > 128) return json(400, { error: "token is required" }, headers);
    if (env.LIMITS) { const k = `pair:${new Date().toISOString().slice(0, 10)}:${request.headers.get("cf-connecting-ip") || "unknown"}`; const n = Number(await env.LIMITS.get(k)) || 0; if (n >= 30) return json(429, { error: "too many pairings today from this address" }, headers); await env.LIMITS.put(k, String(n + 1), { expirationTtl: 86400 }); }
    // only the treasury's owner pairs chats: the request carries a signature by a key of the owner's account
    const bad = await ownerProof({ ...body, treasury });
    if (bad) return json(403, { error: bad }, headers);
    const rec = await kvGet(env, `treasury:${treasury}`);
    if (!rec) await kvPut(env, `treasury:${treasury}`, { token: body.token, chats: [], label: body.label || "", owner: body.owner });
    else if (rec.token !== body.token || (body.label && body.label !== rec.label)) { rec.token = body.token; rec.label = body.label || rec.label; rec.owner = body.owner; await kvPut(env, `treasury:${treasury}`, rec); } // the owner can rotate the token
    const code = newCode();
    await kvPut(env, `pair:${code}`, { treasury, token: body.token, label: body.label || "", for: String(body.for || "").slice(0, 60), vendor: String(body.vendor || "").slice(0, 64), approver: !!body.approver, auto: !!body.auto }, 86400);
    const bot = await botName(env);
    return json(200, { code, bot, link: `https://t.me/${bot}?start=${code}` }, headers);
  }
  const rec = await authed(env, request, treasury);
  if (!rec) return json(401, { error: "bad or missing inbox token" }, headers);
  if (request.method === "GET" && p === "/inbox/list") {
    const items = (await kvGet(env, `inbox:${treasury}`)) || [];
    const chatList = rec.chats.map((c) => ({ chat: c, auto: false, ...(rec.chatInfo?.[c] || { label: "", vendor: "", title: "", since: 0 }), approver: isApprover(rec, c) }));
    return json(200, { items: items.map(stripItem), chats: rec.chats.length, approvers: Object.keys(rec.approvers || {}).length, chatList, bot: await botName(env) }, headers);
  }
  // Change what a connected chat is for, or disconnect it. Items already in the inbox keep the vendor they arrived with.
  if (request.method === "POST" && p === "/inbox/chat") {
    const chat = body.chat; if (chat == null || !rec.chats.some((c) => String(c) === String(chat))) return json(404, { error: "no such chat on this treasury" }, headers);
    if (body.remove) {
      rec.chats = rec.chats.filter((c) => String(c) !== String(chat)); if (rec.chatInfo) delete rec.chatInfo[chat]; if (rec.approvers) delete rec.approvers[String(chat)];
      const link = await kvGet(env, `tg:${chat}`);
      await Promise.all([kvPut(env, `treasury:${treasury}`, rec), link && link.treasury === treasury ? env.INBOX.delete(`tg:${chat}`) : Promise.resolve()]);
      await tg(env, "sendMessage", { chat_id: chat, text: "This chat was disconnected from the company's inbox. Invoices sent here are no longer read." }).catch(() => {});
      return json(200, { ok: true }, headers);
    }
    if (isApprover(rec, chat)) return json(400, { error: "an approver's chat is not a vendor's chat; disconnect it instead" }, headers);
    const link = await kvGet(env, `tg:${chat}`);
    if (!link || link.treasury !== treasury) return json(409, { error: "this chat is no longer connected to this treasury" }, headers);
    const vendor = String(body.vendor || "").slice(0, 64), label = String(body.for || "").slice(0, 60), auto = !!(body.auto && vendor);
    rec.chatInfo = rec.chatInfo || {}; rec.chatInfo[chat] = { ...(rec.chatInfo[chat] || { title: "", since: Date.now() }), label, vendor, auto };
    await Promise.all([kvPut(env, `treasury:${treasury}`, rec), kvPut(env, `tg:${chat}`, { ...link, label, vendor, auto })]);
    return json(200, { ok: true }, headers);
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
  // The console approving waiting invoices in bulk: each is marked like an Approve from Telegram and the agent takes it from there.
  if (request.method === "POST" && p === "/inbox/approve") {
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 100) : [];
    if (!ids.length) return json(400, { error: "ids is required" }, headers);
    const by = String(body.by || "the console").slice(0, 60);
    let approved = 0;
    for (const id of ids) if (/^Approved\./.test(await decide(env, treasury, id, true, by))) approved++;
    return json(200, { ok: true, approved }, headers);
  }
  if (request.method === "POST" && p === "/inbox/discard") {
    const items = (await kvGet(env, `inbox:${treasury}`)) || [];
    const it = items.find((x) => x.id === body.id);
    await kvPut(env, `inbox:${treasury}`, items.filter((x) => x.id !== body.id));
    if (it && it.asked) await tellApprovers(env, rec, it, approverText(env, treasury, it, { status: "discarded" }));
    return json(200, { ok: true }, headers);
  }
  // The agent takes an approved invoice: nobody else reads it for TAKE_TTL; a crashed agent gets it again after that.
  if (request.method === "POST" && p === "/inbox/take") {
    const items = (await kvGet(env, `inbox:${treasury}`)) || [];
    const it = items.find((x) => x.id === body.id);
    if (!it) return json(404, { error: "no such item" }, headers);
    if (it.status !== "approved" && !(it.status === "reading" && Date.now() - (it.taken || 0) > TAKE_TTL)) return json(409, { error: `item is ${it.status || "waiting"}` }, headers);
    it.status = "reading"; it.taken = Date.now();
    await kvPut(env, `inbox:${treasury}`, items);
    return json(200, { item: stripItem(it) }, headers);
  }
  // The outcome of an invoice, from the agent or the console: the item leaves the inbox, the approvers read the decision
  // with the contract's reason, the chat it came from reads only the outcome.
  // With `id`, the first decision on an inbox item; with `payment_id` alone, a later one on a payment the relay remembers
  // (held, then approved or cancelled in the console; queued, then settled): same message thread, same chats.
  if (request.method === "POST" && p === "/inbox/outcome") {
    const items = (await kvGet(env, `inbox:${treasury}`)) || [];
    const pid = body.payment_id != null ? String(body.payment_id).slice(0, 20) : "";
    const followKey = pid ? `pay:${treasury}:${pid}` : "";
    let it = body.id ? items.find((x) => x.id === body.id) : null;
    const later = !it && followKey ? await kvGet(env, followKey) : null;
    if (!it && !later) return json(404, { error: "no such item" }, headers);
    const o = { status: String(body.status || "decided").slice(0, 20), reason: body.reason ? String(body.reason).slice(0, 120) : null, vendor: String(body.vendor || later?.vendor || "").slice(0, 80), invoice_number: String(body.invoice_number || later?.invoice_number || "").slice(0, 80), amount: String(body.amount || later?.amount || "").slice(0, 40), tx_url: /^https:\/\/[\w./-]+$/.test(String(body.tx_url || "")) ? body.tx_url : "", message: String(body.message || "").slice(0, 300) };
    if (it) {
      // an invoice that could not be read goes back to waiting: a person reads it in the console
      if (o.status === "error") { it.status = "waiting"; delete it.taken; await kvPut(env, `inbox:${treasury}`, items); }
      else await kvPut(env, `inbox:${treasury}`, items.filter((x) => x.id !== body.id));
    } else it = later;
    await tellApprovers(env, rec, it, approverText(env, treasury, it, o));
    const v = vendorText(it, o);
    if (v && !isApprover(rec, it.chat)) await tg(env, "sendMessage", { chat_id: it.chat, text: v, disable_web_page_preview: true }).catch(() => {});
    if (followKey) {
      if (FINAL.has(o.status)) { if (later) await env.INBOX.delete(followKey); }
      else await kvPut(env, followKey, { id: it.id, name: it.name, chat: it.chat, asked: it.asked || {}, vendor: o.vendor, invoice_number: o.invoice_number, amount: o.amount }, FOLLOW_TTL);
    }
    return json(200, { ok: true }, headers);
  }
  // There is no free-text route: everything the chats receive is composed here from a decision or an outcome,
  // so a leaked inbox token cannot turn the bot into a messenger for anyone.
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
      const models = (env.ALLOWED_MODELS || "Qwen/Qwen3-VL-30B-A3B-Instruct,z-ai/glm-5.3-flash").split(",").map((s) => s.trim());
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
    if (request.method === "GET" && url.pathname === "/") return json(200, { relay: "bursar", upstream: UPSTREAM, routes: ["POST /v1/chat/completions", "GET /v1/attestation/report", "GET /v1/signature/{id}", "GET /pccs/{intel collateral path}", "POST /tg/webhook", "POST /inbox/pair", "GET /inbox/list", "GET /inbox/file", "POST /inbox/discard", "POST /inbox/take", "POST /inbox/outcome", "POST /inbox/notify"], telegram: !!(env.INBOX && env.TELEGRAM_BOT_TOKEN) }, headers);
    return json(404, { error: "not found" }, headers);
  },
};
