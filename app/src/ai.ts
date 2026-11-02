// NEAR AI Cloud: private inference in a TEE, with attestation and a signed receipt for every decision.
// Docs: https://docs.near.ai/cloud/quickstart.md, /cloud/verification/cloud-api/model-attestations.md,
//       /cloud/verification/cloud-api/response-signatures.md
//
// The gateway signs `<model>:<sha256(request bytes)>:<sha256(response bytes)>`, so this file talks to the
// API with plain fetch and keeps the exact bytes it sent and received. Anything that re-serializes the
// JSON (an SDK, a pretty printer) would break the signature. `verify.ts` checks the receipt later,
// without this API key and without trusting this process.
import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import type { Payout } from "./near.js";

export interface Extraction {
  vendor_name: string;
  vendor_id_guess: string;
  invoice_number: string;
  amount: string; // decimal string, e.g. "480.00"
  currency: string;
  due_date: string; // YYYY-MM-DD
  payout_seen: Payout;
  flags: string[];
  confidence: number;
  /** Purchase order or reference number printed on the invoice, empty if none. */
  order_ref: string;
  /** The vendor's tax id (VAT, EIN, CNPJ...) as printed, empty if none. */
  vendor_tax_id?: string;
  /** The buyer's tax id as printed on the invoice, empty if none. */
  buyer_tax_id?: string;
  /** Subtotal before tax and the tax amount, decimal strings, empty if the invoice does not show them. */
  subtotal?: string;
  tax_amount?: string;
  /** Withholding tax the invoice shows as deducted from the total (ritenuta d'acconto, TDS, retencion), empty if none. */
  withholding?: string;
  /** The amount and the withholding exactly as printed: the client parses these itself, the model's decimal conversion is not trusted. */
  amount_printed?: string;
  withholding_printed?: string;
  /** A deposit or prepayment the invoice subtracts before the amount due, empty if none; the claim carries the remaining due. */
  deposit?: string;
}

/** Everything needed to re-verify one inference independently. Stored next to the payment, never on chain. */
export interface AiReceipt {
  model: string;
  inference_id: string;
  request_sha256: string;
  response_sha256: string;
  attestation_nonce: string;
  signing_address: string | null;
  signing_algo: string | null;
  signature: string | null;
  signature_kind: string | null;
  signed_text: string | null;
  /** Exact bytes sent and received, as UTF-8 strings. The signature covers these. */
  request_body: string;
  response_body: string;
}

/** Shape of `GET /v1/signature/{id}` on the Cloud API. */
export interface SignatureRecord {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo?: string;
  signature_kind: string;
}

/** One entry of `model_attestations` in `GET /v1/attestation/report`. Other fields are kept as is. */
export interface ModelAttestation {
  request_nonce: string;
  signing_algo: string;
  signing_address: string;
  intel_quote: string;
  event_log?: unknown;
  info?: unknown;
  nvidia_payload?: string | null;
  report_data?: string | null;
  tls_cert_fingerprint?: string | null;
  [k: string]: unknown;
}

export interface AttestationReport {
  model_attestations?: ModelAttestation[];
  error?: string;
  [k: string]: unknown;
}

const SYSTEM = `You are the reading half of an AI treasurer. You read one invoice and return JSON only.
You never decide whether to pay: a smart contract does that. Report exactly what the document says.
Fields:
- vendor_name: the company issuing the invoice (the letterhead, "From", "Emittente", "Von", "Fornitore"), never the company it is addressed to ("Bill to", "Spett.le", "Rechnung an")
- vendor_id_guess: lowercase slug of the vendor name, letters and digits only (e.g. "acmehosting")
- invoice_number: as printed
- amount: the invoice total as a decimal string, no currency symbol, before any withholding tax deducted on it. Use a dot for decimals and no thousands separator (European invoices print 1.234,56: return 1234.56)
- amount_printed: that same amount exactly as printed on the document, character by character
- currency: ISO code (USDC, USD, EUR...)
- due_date: YYYY-MM-DD (European invoices print DD/MM/YYYY or DD.MM.YYYY, US invoices MM/DD/YYYY)
- payout_seen: where the invoice asks to be paid. Either {"Near":{"account":"name.near"}} for a NEAR account,
  or {"Chain":{"chain":"base|arb|sol|sui|eth","address":"0x..."}} for another chain (Arbitrum is "arb", Ethereum "eth", Solana "sol"). Copy the address exactly.
- flags: list any of: "new_payment_details" (text like new bank details, updated wallet, please note our new address),
  "urgency" (pay immediately, overdue, final notice), "mismatched_contact" (email or domain differs from the vendor name),
  "handwritten_or_altered", "missing_invoice_number", "unreadable". Empty list if none.
- order_ref: the purchase order or reference number printed on the invoice (labels like "Purchase order", "PO", "Order ref"), as printed; empty string if none
- vendor_tax_id: the issuing company's tax identifier as printed (VAT number, EIN, CNPJ, GSTIN, ABN, supplier code...), often in the letterhead; empty string if none
- buyer_tax_id: the tax identifier of the company the invoice is addressed to ("Bill to"), as printed; empty string if none
- subtotal: the amount before tax as a decimal string (same format as amount), empty string if not shown
- tax_amount: the tax amount as a decimal string, empty string if not shown
- withholding: withholding tax the invoice shows as deducted from the total (labels like "withholding tax", "ritenuta d'acconto", "TDS", "retencion"), decimal string, empty string if none. A deposit or prepayment already received is not withholding
- withholding_printed: the withholding amount exactly as printed, empty string if none
- deposit: a deposit, prepayment or credit the invoice shows as already received and subtracted before the amount due, decimal string, empty string if none
- confidence: 0 to 1
Return only the JSON object.`;

export function sha256(s: string | Buffer | Uint8Array) {
  return createHash("sha256").update(s).digest("hex");
}

// `NEAR_AI_API_KEY=proxy`: send no Authorization header, an egress proxy that holds the key adds it (cloud dev sessions).
const headers = (): Record<string, string> =>
  config.aiApiKey === "proxy" ? { "x-no-aliasing": "true" } : { Authorization: `Bearer ${config.aiApiKey}`, "x-no-aliasing": "true" };

/** Preflight: fetch the model attestation bound to a fresh nonce. We keep the nonce in the receipt. */
export async function fetchAttestation(nonce: string, model = config.aiModel): Promise<AttestationReport> {
  const url = `${config.aiBaseUrl}/attestation/report?model=${encodeURIComponent(model)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`attestation ${r.status}: ${await r.text()}`);
  return (await r.json()) as AttestationReport;
}

/** Ask the gateway for the signature over (request, response) of a completion id. */
export async function fetchSignature(id: string): Promise<SignatureRecord | null> {
  // The signature can lag the completion by a few seconds: ask a few times before giving up.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${config.aiBaseUrl}/signature/${encodeURIComponent(id)}?signing_algo=ecdsa`, { headers: headers() });
      if (r.ok) { const j = (await r.json()) as Partial<SignatureRecord>; if (j.signature && j.text && j.signing_address) return j as SignatureRecord; }
    } catch {}
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  return null;
}

/**
 * Read an invoice. `pngPages` are rasterized pages (the TEE models accept images, not PDFs).
 * Returns the extraction and a receipt that ties this exact decision to the TEE.
 */
export async function readInvoice(pngPages: Buffer[], textFallback?: string): Promise<{ extraction: Extraction; receipt: AiReceipt; attestation: AttestationReport }> {
  if (!config.aiApiKey) throw new Error("NEAR_AI_API_KEY is not set");
  const nonce = randomBytes(32).toString("hex");
  let model = config.aiModel;
  let attestation = await fetchAttestation(nonce, model).catch((e) => ({ error: String(e) }) as AttestationReport);

  const content: unknown[] = [{ type: "text", text: "Read this invoice." }];
  for (const p of pngPages) content.push({ type: "image_url", image_url: { url: `data:${p[0] === 0xff && p[1] === 0xd8 ? "image/jpeg" : "image/png"};base64,${p.toString("base64")}` } });
  if (textFallback) content.push({ type: "text", text: `Extracted text, in case the image is unclear:\n${textFallback.slice(0, 12000)}` });

  const bodyFor = (m: string) => JSON.stringify({ model: m, temperature: 0, messages: [{ role: "system", content: SYSTEM }, { role: "user", content }], response_format: { type: "json_object" }, stream: false });
  let requestBody = bodyFor(model);
  // The gateway answers 502 now and then ("upstream request failed"): retry a few times before giving up. When the
  // chosen model fails and another is configured (NEAR_AI_MODEL_FALLBACK), it takes over with its own attestation.
  const TRANSIENT = [429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530];
  let r!: Response;
  let responseBody = "";
  let switched = false;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: requestBody,
    });
    responseBody = await r.text();
    if (r.ok || !TRANSIENT.includes(r.status)) break;
    if (!switched && config.aiModelFallback && config.aiModelFallback !== model) {
      switched = true; model = config.aiModelFallback; requestBody = bodyFor(model);
      console.error(`[ai] ${config.aiModel} answered ${r.status}: switching to ${model}`);
      attestation = await fetchAttestation(nonce, model).catch((e) => ({ error: String(e) }) as AttestationReport);
      continue;
    }
    if (attempt >= 3) break;
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
  }
  if (!r.ok) throw new Error(`chat ${r.status}: ${responseBody.slice(0, 500)}`);
  const completion = JSON.parse(responseBody);
  const text: string = completion.choices?.[0]?.message?.content ?? "{}";
  const extraction = JSON.parse(text) as Extraction;

  const sig = await fetchSignature(completion.id).catch(() => null);
  const receipt: AiReceipt = {
    model,
    inference_id: completion.id,
    request_sha256: sha256(requestBody),
    response_sha256: sha256(responseBody),
    attestation_nonce: nonce,
    signing_address: sig?.signing_address ?? null,
    signing_algo: sig?.signing_algo ?? null,
    signature: sig?.signature ?? null,
    signature_kind: sig?.signature_kind ?? null,
    signed_text: sig?.text ?? null,
    request_body: requestBody,
    response_body: responseBody,
  };
  return { extraction, receipt, attestation };
}

/** Compact reference stored on chain next to the payment. */
export function attestationRef(r: AiReceipt): string {
  return `nearai:${r.model}:${r.inference_id}:${r.request_sha256.slice(0, 16)}:${r.response_sha256.slice(0, 16)}:${r.signing_address ?? "-"}`;
}

/** Offline mode for CI and judges without an API key: a deterministic parser for the demo invoices. */
export function readInvoiceOffline(text: string): Extraction {
  const pick = (re: RegExp) => text.match(re)?.[1]?.trim() ?? "";
  const vendor = pick(/From:\s*(.+?)(?:\s{2,}|$)/im);
  const near = pick(/Pay to NEAR account:\s*([a-z0-9._-]+)/i);
  const chain = pick(/Pay to\s+(base|arb|sol|sui|eth)\s+address:/i).toLowerCase();
  const addr = pick(/address:\s*(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/);
  // the demo invoices label the buyer's id "Customer VAT"; the vendor's is the plain "VAT" line
  const idRe = /(?:VAT|Tax id|EIN|CNPJ|GSTIN|ABN|Supplier code)\s*(?:no\.?|number)?\s*:\s*([A-Z]{0,3}[0-9][A-Z0-9]{3,20})/gi;
  const buyerId = text.match(/Customer\s+(?:VAT|Tax id)\s*(?:no\.?|number)?\s*:\s*([A-Z]{0,3}[0-9][A-Z0-9]{3,20})/i)?.[1] ?? "";
  const vendorId = [...text.matchAll(idRe)].map((m) => m[1]).find((id) => id !== buyerId) ?? "";
  const flags: string[] = [];
  if (/new (bank|wallet|payment) (details|address)|updated wallet|please note our new/i.test(text)) flags.push("new_payment_details");
  if (/immediately|final notice|overdue/i.test(text)) flags.push("urgency");
  return {
    vendor_name: vendor,
    vendor_id_guess: vendor.toLowerCase().replace(/[^a-z0-9]/g, ""),
    invoice_number: pick(/Invoice\s*(?:#|No\.?|number)\s*:?\s*([A-Z]{1,4}-?[0-9]{2,8})/i),
    amount: pick(/\bTotal(?: due)?:\s*([0-9][0-9,]*\.?[0-9]*)/i).replace(/,/g, ""),
    withholding: pick(/(?:Withholding|Ritenuta)[^:\n]*:\s*-?\s*([0-9][0-9,]*\.?[0-9]*)/i).replace(/,/g, ""),
    currency: pick(/\bTotal(?: due)?:\s*[0-9.,]+\s*([A-Z]{3,4})/i) || "USDC",
    due_date: pick(/Due date:\s*(\d{4}-\d{2}-\d{2})/i),
    payout_seen: near ? { Near: { account: near } } : { Chain: { chain, address: addr } },
    flags,
    confidence: 0.9, // a parser, not a model: deterministic on the demo invoices
    order_ref: pick(/(?:Purchase order|Order ref(?:erence)?|PO)\s*(?:#|No\.?|number)?\s*:?\s*([A-Z]{1,4}-?[0-9]{2,8}(?:-[0-9A-Z]{1,8})?)/i),
    // the demo invoices print the vendor's id first and the buyer's second, whatever the column layout does to the text order
    vendor_tax_id: vendorId,
    buyer_tax_id: buyerId,
    subtotal: pick(/Subtotal:\s*([0-9][0-9,]*\.?[0-9]*)/i).replace(/,/g, ""),
    tax_amount: pick(/(?:VAT|Tax)\s*(?:\([^)]*\))?\s*:\s*([0-9][0-9,]*\.?[0-9]*)/i).replace(/,/g, ""),
  };
}

/**
 * Checks on the model's reading that do not trust the model: each one that fails becomes a flag, and a flag
 * makes the contract hold the payment for a person. They never let a payment through; they only stop it.
 */
export function readingFlags(ex: Extraction, text: string): string[] {
  const flags: string[] = [];
  // the amount the claim will carry, not the model's decimal: that is what gets paid and what the text must contain
  const amount = Number(claimValues(ex).amount || "0");
  // every number in the text; "money" is the ones written with cents, which is how invoices print amounts
  const nums = (text.match(/\d[\d.,]*\d|\d/g) ?? []).map((n) => parseMoney(n)).filter((n) => Number.isFinite(n));
  const money = (text.match(/\d[\d.,]*[.,]\d{2}(?![\d.,])/g) ?? []).map((n) => parseMoney(n)).filter((n) => Number.isFinite(n));
  if (!text.trim()) flags.push("no_text_layer");
  else if (amount > 0 && !nums.some((n) => Math.abs(n - amount) < 0.005)) flags.push("amount_not_in_text");
  else if (amount > 0 && money.some((n) => n > amount + 0.005)) flags.push("larger_amount_in_text");
  if (ex.subtotal && ex.tax_amount) {
    const sum = Number(ex.subtotal) + Number(ex.tax_amount);
    if (Number.isFinite(sum) && Math.abs(sum - amount) > 0.01) flags.push("totals_mismatch");
  }
  if (typeof ex.confidence === "number" && ex.confidence < 0.6) flags.push("low_confidence");
  if (ex.currency && ex.currency.toUpperCase() !== "USDC") flags.push("currency_not_usdc");
  return flags;
}
const CHAIN_ALIASES: Record<string, string> = { arbitrum: "arb", "arbitrum one": "arb", arb: "arb", ethereum: "eth", eth: "eth", mainnet: "eth", solana: "sol", sol: "sol", sui: "sui", base: "base", near: "near" };
/**
 * The values a claim carries, taken from the model's reading without trusting its number formatting: the amount printed on
 * the document, parsed here ("1.234,56" and "1,234.56" both read as 1234.56), wins over the model's decimal conversion;
 * a negative or missing withholding is zero; chain names are the short ones the contract knows. The extraction itself is
 * left as the model wrote it, because the receipt is verified against the signed response.
 */
/** No invoice is worth a trillion USDC: a runaway number from the model is clipped here, and the contract blocks it as over the cap. */
export const MAX_AMOUNT = 1e12;
export function claimValues(ex: Extraction): { amount: string; withholding: string; payout_seen: Payout } {
  const fix = (decimal: string | undefined, printed: string | undefined): string => {
    const fromPrinted = printed && /\d/.test(printed) ? parseMoney(printed.replace(/[^\d.,]/g, "")) : NaN;
    let n = Number.isFinite(fromPrinted) ? fromPrinted : parseMoney(String(decimal ?? "").replace(/[^\d.,]/g, ""));
    // "5.04656" is what a model makes of "5.046,56": a dot followed by five digits is a thousands dot plus two decimals
    const m = String(decimal ?? "").match(/^(\d{1,3})\.(\d{3})(\d{2})$/);
    if (!Number.isFinite(fromPrinted) && m) n = Number(`${m[1]}${m[2]}.${m[3]}`);
    if (!Number.isFinite(n) || n < 0) n = 0;
    return Math.min(n, MAX_AMOUNT).toFixed(2);
  };
  let payout = ex.payout_seen;
  if (payout && "Chain" in payout && payout.Chain) {
    const key = String(payout.Chain.chain ?? "").toLowerCase().trim();
    payout = { Chain: { chain: CHAIN_ALIASES[key] ?? key, address: String(payout.Chain.address ?? "").trim() } };
  } else if (payout && "Near" in payout && payout.Near) payout = { Near: { account: String(payout.Near.account ?? "").trim().toLowerCase() } };
  const deposit = ex.deposit ? Number(fix(ex.deposit, undefined)) : 0;
  let withholding = ex.withholding || ex.withholding_printed ? fix(ex.withholding, ex.withholding_printed) : "0";
  if (deposit > 0 && Math.abs(Number(withholding) - deposit) < 0.005) withholding = "0"; // the model put the deposit in both places
  let amount = Number(fix(ex.amount, ex.amount_printed));
  // Reconcile with the printed subtotal and tax, as a bookkeeper would: the contract wants the total before withholding,
  // less a deposit already received. The model sometimes reports the net after withholding, or the total before the deposit.
  const near = (x: number, y: number) => Math.abs(x - y) < 0.011;
  const gross = ex.subtotal && ex.tax_amount ? Number(fix(ex.subtotal, undefined)) + Number(fix(ex.tax_amount, undefined)) : NaN;
  if (Number.isFinite(gross) && gross > 0) {
    const w = Number(withholding);
    if (w > 0 && !near(amount, gross) && near(amount + w, gross)) amount = gross; // net after withholding was reported
    if (deposit > 0 && near(amount, gross)) amount = gross - deposit; // the total before the deposit was reported
  } else if (deposit > 0 && amount > deposit && ex.deposit && !near(amount, deposit)) {
    // no subtotal to check against: trust the model's amount as what is due (it already subtracted the deposit when it filled the field)
  }
  return { amount: Math.min(MAX_AMOUNT, Math.max(0, amount)).toFixed(2), withholding, payout_seen: payout };
}
const KNOWN_FLAGS = new Set(["new_payment_details", "urgency", "mismatched_contact", "handwritten_or_altered", "missing_invoice_number", "unreadable"]);
/**
 * The flags a claim carries: the model's, kept to the names the prompt defines (it invents others, like the text of a
 * watermark), minus the ones its own reading contradicts, plus the client checks of readingFlags. "new_payment_details"
 * when the payout read is the one the owner registered is a contradiction too (a notice pointing at the recorded
 * destination changes nothing; a different destination is refused by the contract whatever the flags say):
 * on a thousand invented invoices the model raised it on one legitimate invoice in seven.
 */
export function claimFlags(ex: Extraction, text: string, registeredPayout?: Payout | null): string[] {
  const values = claimValues(ex);
  const model = (ex.flags ?? []).filter((f) => KNOWN_FLAGS.has(f)).filter((f) => {
    if (f === "missing_invoice_number" && (ex.invoice_number ?? "").trim()) return false;
    if (f === "new_payment_details" && registeredPayout && JSON.stringify(values.payout_seen) === JSON.stringify(claimValues({ ...ex, payout_seen: registeredPayout }).payout_seen)) return false;
    return true;
  });
  return [...new Set([...model, ...readingFlags(ex, text)])];
}
/** The contract bounds every claim field; the client clips what the model wrote so a long line records a refusal instead of failing the call. */
export const CLAIM_LIMITS = { vendor_id: 64, invoice_number: 128, due_date: 32, invoice_hash: 128, attestation_ref: 512, flag: 64, flags: 16, tax_id: 64, order_ref: 128, chain: 32, address: 256 };
export function clip(s: string | null | undefined, n: number): string {
  const t = String(s ?? "");
  return t.length <= n ? t : t.slice(0, n);
}
/** Why a payout read from the invoice cannot go to the contract as it is (an abbreviated or garbled NEAR account would not even deserialize), or null. */
export function payoutProblem(p: Payout | null | undefined): string | null {
  if (!p || !("Near" in p ? p.Near : "Chain" in p ? p.Chain : null)) return "no payout destination was read on the invoice";
  if ("Near" in p && p.Near) { const a = p.Near.account; if (a.length < 2 || a.length > 64 || !/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a)) return `the NEAR account read on the invoice is not a valid account id: ${a}`; }
  if ("Chain" in p && p.Chain && !p.Chain.address) return "the payout address read on the invoice is empty";
  return null;
}
/** "1.250,00", "1,250.00", "1250" all read as 1250. */
/** Printed money to a number. Both separators: the last one is the decimal mark. One separator alone, once, followed by
 *  exactly three digits ("1.250", "1,250"): a thousands separator, invoices print two decimals. Several of the same: thousands. */
export function parseMoney(s: string): number {
  const t = s.replace(/\s/g, "");
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  const dots = t.split(".").length - 1, commas = t.split(",").length - 1;
  let norm: string;
  if (lastDot >= 0 && lastComma >= 0) norm = lastDot > lastComma ? t.replace(/,/g, "") : t.replace(/\./g, "").replace(",", ".");
  else if (lastComma >= 0) norm = commas === 1 && t.length - lastComma !== 4 ? t.replace(",", ".") : t.replace(/,/g, "");
  else if (lastDot >= 0) norm = dots === 1 && t.length - lastDot !== 4 ? t : t.replace(/\./g, "");
  else norm = t;
  return Number(norm);
}

