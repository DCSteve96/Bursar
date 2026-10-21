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
- vendor_name: the company issuing the invoice
- vendor_id_guess: lowercase slug of the vendor name, letters and digits only (e.g. "acmehosting")
- invoice_number: as printed
- amount: total due as a decimal string, no currency symbol
- currency: ISO code (USDC, USD, EUR...)
- due_date: YYYY-MM-DD
- payout_seen: where the invoice asks to be paid. Either {"Near":{"account":"name.near"}} for a NEAR account,
  or {"Chain":{"chain":"base|arb|sol|sui|eth","address":"0x..."}} for another chain. Copy the address exactly.
- flags: list any of: "new_payment_details" (text like new bank details, updated wallet, please note our new address),
  "urgency" (pay immediately, overdue, final notice), "mismatched_contact" (email or domain differs from the vendor name),
  "handwritten_or_altered", "missing_invoice_number", "unreadable". Empty list if none.
- order_ref: the purchase order or reference number printed on the invoice (labels like "Purchase order", "PO", "Order ref"), as printed; empty string if none
- vendor_tax_id: the issuing company's tax identifier as printed (VAT number, EIN, CNPJ, GSTIN, ABN, supplier code...), empty string if none
- buyer_tax_id: the tax identifier of the company the invoice is addressed to ("Bill to"), as printed; empty string if none
- subtotal: the amount before tax as a decimal string, empty string if not shown
- tax_amount: the tax amount as a decimal string, empty string if not shown
- confidence: 0 to 1
Return only the JSON object.`;

export function sha256(s: string | Buffer | Uint8Array) {
  return createHash("sha256").update(s).digest("hex");
}

// `NEAR_AI_API_KEY=proxy`: send no Authorization header, an egress proxy that holds the key adds it (cloud dev sessions).
const headers = (): Record<string, string> =>
  config.aiApiKey === "proxy" ? { "x-no-aliasing": "true" } : { Authorization: `Bearer ${config.aiApiKey}`, "x-no-aliasing": "true" };

/** Preflight: fetch the model attestation bound to a fresh nonce. We keep the nonce in the receipt. */
export async function fetchAttestation(nonce: string): Promise<AttestationReport> {
  const url = `${config.aiBaseUrl}/attestation/report?model=${encodeURIComponent(config.aiModel)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`attestation ${r.status}: ${await r.text()}`);
  return (await r.json()) as AttestationReport;
}

/** Ask the gateway for the signature over (request, response) of a completion id. */
export async function fetchSignature(id: string): Promise<SignatureRecord | null> {
  const r = await fetch(`${config.aiBaseUrl}/signature/${encodeURIComponent(id)}?signing_algo=ecdsa`, { headers: headers() });
  if (!r.ok) return null;
  const j = (await r.json()) as Partial<SignatureRecord>;
  if (!j.signature || !j.text || !j.signing_address) return null;
  return j as SignatureRecord;
}

/**
 * Read an invoice. `pngPages` are rasterized pages (the TEE models accept images, not PDFs).
 * Returns the extraction and a receipt that ties this exact decision to the TEE.
 */
export async function readInvoice(pngPages: Buffer[], textFallback?: string): Promise<{ extraction: Extraction; receipt: AiReceipt; attestation: AttestationReport }> {
  if (!config.aiApiKey) throw new Error("NEAR_AI_API_KEY is not set");
  const nonce = randomBytes(32).toString("hex");
  const attestation = await fetchAttestation(nonce).catch((e) => ({ error: String(e) }) as AttestationReport);

  const content: unknown[] = [{ type: "text", text: "Read this invoice." }];
  for (const p of pngPages) content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${p.toString("base64")}` } });
  if (textFallback) content.push({ type: "text", text: `Extracted text, in case the image is unclear:\n${textFallback.slice(0, 12000)}` });

  const body = {
    model: config.aiModel,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content },
    ],
    response_format: { type: "json_object" },
    stream: false,
  };
  const requestBody = JSON.stringify(body);
  // The gateway answers 502 now and then ("upstream request failed"): retry a few times before giving up.
  let r!: Response;
  let responseBody = "";
  for (let attempt = 0; ; attempt++) {
    r = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: requestBody,
    });
    responseBody = await r.text();
    if (r.ok || attempt >= 3 || ![429, 502, 503, 504].includes(r.status)) break;
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
  }
  if (!r.ok) throw new Error(`chat ${r.status}: ${responseBody.slice(0, 500)}`);
  const completion = JSON.parse(responseBody);
  const text: string = completion.choices?.[0]?.message?.content ?? "{}";
  const extraction = JSON.parse(text) as Extraction;

  const sig = await fetchSignature(completion.id).catch(() => null);
  const receipt: AiReceipt = {
    model: config.aiModel,
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
    amount: pick(/Total due:\s*([0-9][0-9,]*\.?[0-9]*)/i).replace(/,/g, ""),
    currency: pick(/Total due:\s*[0-9.,]+\s*([A-Z]{3,4})/i) || "USDC",
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
  const amount = Number(ex.amount || "0");
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
/** "1.250,00", "1,250.00", "1250" all read as 1250. */
export function parseMoney(s: string): number {
  const t = s.replace(/\s/g, "");
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  let norm: string;
  if (lastDot >= 0 && lastComma >= 0) norm = lastDot > lastComma ? t.replace(/,/g, "") : t.replace(/\./g, "").replace(",", ".");
  else if (lastComma >= 0) norm = t.length - lastComma === 3 ? t.replace(",", ".") : t.replace(/,/g, "");
  else norm = t;
  return Number(norm);
}

