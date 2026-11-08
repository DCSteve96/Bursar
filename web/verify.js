// The receipt verifier, as an ES module for the public pages (the landing's tamper switch and verify.html).
// The same checks as app/src/verify.ts and the console: bytes, signed text, ECDSA signature, signer kind, attestation
// signer and nonce, TDX quote binding, Intel collateral (through the relay), extraction, completion id, attestation
// reference, and the payment on chain. Pages import the libraries through an import map pinned with integrity hashes.
// A classic script, not a module: a page opened as a local file cannot import a relative module, but it can
// import() the libraries from the CDN. Pages use window.BursarVerify after awaiting BursarVerify.ready.
(() => {
let secp256k1, keccak_256, sha256;
const ready = Promise.all([
  import("https://cdn.jsdelivr.net/npm/@noble/curves@2.4.0/secp256k1.js/+esm"),
  import("https://cdn.jsdelivr.net/npm/@noble/hashes@2.4.0/sha3.js/+esm"),
  import("https://cdn.jsdelivr.net/npm/@noble/hashes@2.4.0/sha2.js/+esm"),
]).then(([c, s3, s2]) => { secp256k1 = c.secp256k1; keccak_256 = s3.keccak_256; sha256 = s2.sha256; });

const te = new TextEncoder(), td = new TextDecoder();
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => { h = h.replace(/^0x/i, ""); const u = new Uint8Array(h.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16); return u; };
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const sha256hex = (s) => toHex(sha256(te.encode(s)));
const attestationRef = (r) => `nearai:${r.model}:${r.inference_id}:${r.request_sha256.slice(0, 16)}:${r.response_sha256.slice(0, 16)}:${r.signing_address ?? "-"}`;
function eip191Hash(text) { const m = te.encode(text); return keccak_256(concat(te.encode(`\x19Ethereum Signed Message:\n${m.length}`), m)); }
function recoverAddress(text, sigHex) {
  const sig = fromHex(sigHex);
  if (sig.length !== 65) throw new Error(`signature is ${sig.length} bytes, expected 65`);
  let v = sig[64]; if (v >= 27) v -= 27;
  const s = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(v);
  const pub = s.recoverPublicKey(eip191Hash(text)).toBytes(false);
  return "0x" + toHex(keccak_256(pub.subarray(1)).subarray(12));
}

const RELAY = "https://bursar-relay.pupazzipunkapi.workers.dev";
const RPC = { testnet: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"], mainnet: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"] };
async function viewPayment(network, treasury, id) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "v", method: "query", params: { request_type: "call_function", finality: "final", account_id: treasury, method_name: "get_payment", args_base64: btoa(JSON.stringify({ id })) } });
  let last = null;
  for (const url of RPC[network] || RPC.testnet) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status >= 500) { last = new Error(`${new URL(url).host} answered ${r.status}`); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.data?.message ?? j.error.message ?? "rpc error");
      if (j.result.error) throw new Error(j.result.error);
      return JSON.parse(td.decode(new Uint8Array(j.result.result)));
    } catch (e) { last = e; }
  }
  throw last || new Error("no RPC answered");
}

/** Reads a receipt file: from the network, or from samples/readings.js when the page is opened as a local file. */
async function loadReceipt(url) {
  try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
  const key = url.split("/").pop().replace(/^receipt-/, "").replace(/\.json$/, "");
  if (!window.BURSAR_READINGS) await new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = new URL("samples/readings.js", document.baseURI).href; sc.onload = res; sc.onerror = () => rej(new Error("samples/readings.js could not be loaded")); document.head.appendChild(sc); });
  const rf = window.BURSAR_READINGS?.[key];
  if (!rf) throw new Error(`no recorded reading named ${key}`);
  return rf;
}

/**
 * Verifies a receipt file ({ file, extraction, claim, tx, payment, ai: { receipt, attestation } }).
 * Options: relay (for Intel collateral; null skips), network and treasury (for the on-chain check; onChain false skips).
 * Returns { ok, checks: [{ name, ok (true, false or null for skipped), detail }] }.
 */
async function verifyReceipt(rf, opts = {}) {
  await ready;
  const relay = opts.relay === undefined ? RELAY : opts.relay;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const r = rf?.ai?.receipt;
  if (!r) { add("receipt", false, "no AI receipt in this file (the offline parser was used)"); return { ok: false, checks }; }
  let model = r.model; try { model = JSON.parse(r.request_body).model ?? r.model; } catch {}
  const expected = `${model}:${sha256hex(r.request_body)}:${sha256hex(r.response_body)}`;
  add("bytes", r.request_sha256 === sha256hex(r.request_body) && r.response_sha256 === sha256hex(r.response_body), r.request_sha256 === sha256hex(r.request_body) && r.response_sha256 === sha256hex(r.response_body) ? "request and response hashes match the stored bytes" : "the stored bytes do not hash to the receipt's hashes: the bytes were changed");
  if (!r.signed_text || !r.signature || !r.signing_address) add("signature", false, "no signature in the receipt");
  else {
    add("signed_text", r.signed_text === expected, r.signed_text === expected ? `signed text is ${expected.slice(0, 40)}...` : "the gateway signed different bytes");
    try { const rec = recoverAddress(r.signed_text, r.signature); const ok = rec.toLowerCase() === r.signing_address.toLowerCase(); add("signature", ok, ok ? `ECDSA signature recovers to ${rec}` : `recovers to ${rec}, receipt says ${r.signing_address}`); }
    catch (e) { add("signature", false, `cannot recover signer: ${e.message}`); }
    add("signer_kind", r.signature_kind === "provider_tee", r.signature_kind === "provider_tee" ? "signed inside the model TEE (provider_tee)" : `signature kind is ${r.signature_kind}: the gateway signed, not the enclave`);
  }
  const att = rf.ai.attestation || {};
  const want = (r.signing_address ?? "").toLowerCase().replace(/^0x/, "");
  const m = att.model_attestations?.find((x) => x.signing_address.toLowerCase().replace(/^0x/, "") === want);
  if (!m) add("attestation", false, att.error ? `attestation fetch failed: ${att.error}` : "no model attestation carries the signing address");
  else {
    add("attestation_signer", true, `attestation report lists signer ${m.signing_address}`);
    const nonceOk = m.request_nonce.toLowerCase() === r.attestation_nonce.toLowerCase();
    add("attestation_nonce", nonceOk, nonceOk ? "report echoes our fresh nonce" : "nonce mismatch: the report was not produced for this request");
    let quoteBytes = null;
    try {
      // TDX quote v4: 48-byte header, then the TD report; report_data is the last 64 bytes of a TD10 body (offset 568), mr_td at 184.
      const qb = fromHex(m.intel_quote); quoteBytes = qb;
      const version = qb[0] | (qb[1] << 8), teeType = qb[4] | (qb[5] << 8) | (qb[6] << 16) | (qb[7] << 24);
      if (version !== 4 && version !== 5) add("quote_report_data", false, `unexpected quote version ${version}`);
      else if (teeType !== 0x81) add("quote_report_data", false, `quote tee type ${teeType} is not TDX`);
      else {
        const rd = qb.subarray(568, 632);
        const addrOk = toHex(rd.subarray(0, 20)) === want && rd.subarray(20, 32).every((b) => b === 0);
        const nonceInQuote = toHex(rd.subarray(32, 64)) === r.attestation_nonce.toLowerCase();
        add("quote_report_data", addrOk && nonceInQuote, addrOk && nonceInQuote ? `TDX quote report_data binds signer and nonce (mrtd ${toHex(qb.subarray(184, 232)).slice(0, 16)}...)` : `report_data does not bind ${addrOk ? "nonce" : "signer"}`);
      }
    } catch (e) { add("quote_report_data", false, `cannot parse intel_quote: ${e.message}`); }
    if (quoteBytes && relay) {
      try {
        let qvl = null;
        try { qvl = await import("https://esm.sh/@phala/dcap-qvl@0.7.0?bundle"); } catch (e) { add("quote_tcb", null, `skipped: the quote verifier could not load (${String(e.message || e).slice(0, 60)}); the CLI checks it`); }
        if (qvl) {
          let collateral = null;
          try { collateral = await qvl.getCollateral(`${relay}/pccs`, quoteBytes); }
          catch (e) { add("quote_tcb", null, `skipped: Intel collateral could not be fetched through the relay (${String(e.message || e).slice(0, 60)}); the CLI checks it`); }
          if (collateral) {
            const vr = qvl.verify(quoteBytes, collateral, Math.floor(Date.now() / 1000));
            const good = vr.status === "UpToDate" || vr.status === "SWHardeningNeeded";
            add("quote_tcb", good, `quote verified against Intel collateral: TCB ${vr.status}${vr.advisory_ids?.length ? ` (${vr.advisory_ids.join(", ")})` : ""}`);
          }
        }
      } catch (e) { add("quote_tcb", false, `the quote does not verify against Intel collateral (${String(e.message || e).slice(0, 80)})`); }
    } else add("quote_tcb", null, "skipped: the CLI checks the quote against Intel collateral");
  }
  try {
    const completion = JSON.parse(r.response_body);
    const said = JSON.parse(completion.choices?.[0]?.message?.content ?? "{}");
    add("extraction", JSON.stringify(said) === JSON.stringify(rf.extraction), JSON.stringify(said) === JSON.stringify(rf.extraction) ? "the claim was built from exactly this model output" : "the claim was not built from this model output");
    add("completion_id", completion.id === r.inference_id, `completion id ${completion.id}`);
  } catch (e) { add("extraction", false, `cannot parse response: ${e.message}`); }
  add("attestation_ref", rf.claim?.attestation_ref === attestationRef(r), `claim carries ${attestationRef(r).slice(0, 48)}...`);
  if (opts.onChain !== false && rf.payment?.id !== undefined && opts.treasury) {
    try {
      const p = await viewPayment(opts.network || "testnet", opts.treasury, rf.payment.id);
      const ref = attestationRef(r);
      const clipped = !!p && p.status === "Blocked" && typeof p.attestation_ref === "string" && p.attestation_ref.length === 64 && ref.startsWith(p.attestation_ref);
      const same = !!p && (p.attestation_ref === ref || clipped);
      add("on_chain", same, p ? (same ? `payment #${rf.payment.id} on ${opts.treasury} carries this reference${clipped ? " (its first 64 characters: refusals are stored small)" : ""}` : "the on-chain payment carries a different attestation reference") : "payment not found on chain");
    } catch (e) { add("on_chain", null, `skipped: ${String(e.message || e).slice(0, 80)}`); }
  }
  return { ok: checks.every((c) => c.ok !== false), checks };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** Renders the checks into a container as .chk rows and a verdict line. */
function renderChecks(el, v, tampered = false) {
  el.innerHTML = v.checks.map((c) => `<div class="chk ${c.ok === null ? "skip" : c.ok ? "ok" : "bad"}"><span class="mk">${c.ok === null ? "–" : c.ok ? "✓" : "✕"}</span><span><b>${esc(c.name)}</b> ${esc(c.detail)}</span></div>`).join("")
    + `<div class="verdict ${v.ok ? "ok" : "bad"}">${v.ok ? "VERIFIED: the decision was made on this model output, inside an attested TEE" : tampered ? "NOT VERIFIED: one byte changed, the signature no longer covers these bytes" : "NOT VERIFIED: this receipt does not prove the reading"}</div>`;
}
window.BursarVerify = { ready, verifyReceipt, renderChecks, loadReceipt, attestationRef, RELAY };
})();
