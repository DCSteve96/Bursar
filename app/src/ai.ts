// NEAR AI Cloud: private inference in a TEE, with attestation and a signed receipt for every decision.
// Docs: https://docs.near.ai/cloud/quickstart.md, /cloud/verification/cloud-api/model-attestations.md,
//       /cloud/verification/cloud-api/response-signatures.md
import OpenAI from "openai";
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
}

export interface AiReceipt {
  model: string;
  inference_id: string;
  request_sha256: string;
  response_sha256: string;
  attestation_nonce: string;
  signing_address: string | null;
  signature: string | null;
  signature_kind: string | null;
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
- confidence: 0 to 1
Return only the JSON object.`;

function sha256(s: string | Buffer) {
  return createHash("sha256").update(s).digest("hex");
}

const client = () =>
  new OpenAI({ baseURL: config.aiBaseUrl, apiKey: config.aiApiKey || "missing", defaultHeaders: { "x-no-aliasing": "true" } });

/** Preflight: fetch the model attestation bound to a fresh nonce. We keep the nonce in the receipt. */
export async function fetchAttestation(nonce: string): Promise<unknown> {
  const url = `${config.aiBaseUrl}/attestation/report?model=${encodeURIComponent(config.aiModel)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${config.aiApiKey}`, "x-no-aliasing": "true" } });
  if (!r.ok) throw new Error(`attestation ${r.status}: ${await r.text()}`);
  return r.json();
}

/** Ask the gateway for the signature over (request, response) of a completion id. */
export async function fetchSignature(id: string): Promise<{ text: string; signature: string; signing_address: string; signature_kind: string } | null> {
  const r = await fetch(`${config.aiBaseUrl}/signature/${encodeURIComponent(id)}?signing_algo=ecdsa`, {
    headers: { Authorization: `Bearer ${config.aiApiKey}` },
  });
  if (!r.ok) return null;
  return r.json();
}

/**
 * Read an invoice. `pngPages` are rasterized pages (the TEE models accept images, not PDFs).
 * Returns the extraction and a receipt that ties this exact decision to the TEE.
 */
export async function readInvoice(pngPages: Buffer[], textFallback?: string): Promise<{ extraction: Extraction; receipt: AiReceipt; attestation: unknown }> {
  const nonce = randomBytes(32).toString("hex");
  const attestation = await fetchAttestation(nonce).catch((e) => ({ error: String(e) }));

  const content: any[] = [{ type: "text", text: "Read this invoice." }];
  for (const p of pngPages) content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${p.toString("base64")}` } });
  if (textFallback) content.push({ type: "text", text: `Extracted text, in case the image is unclear:\n${textFallback.slice(0, 12000)}` });

  const body = {
    model: config.aiModel,
    temperature: 0,
    messages: [
      { role: "system" as const, content: SYSTEM },
      { role: "user" as const, content },
    ],
    response_format: { type: "json_object" as const },
    stream: false as const,
  };
  const reqJson = JSON.stringify(body);
  const completion = await client().chat.completions.create(body);
  const resJson = JSON.stringify(completion);
  const text = completion.choices[0]?.message?.content ?? "{}";
  const extraction = JSON.parse(text) as Extraction;

  const sig = await fetchSignature(completion.id).catch(() => null);
  const receipt: AiReceipt = {
    model: config.aiModel,
    inference_id: completion.id,
    request_sha256: sha256(reqJson),
    response_sha256: sha256(resJson),
    attestation_nonce: nonce,
    signing_address: sig?.signing_address ?? null,
    signature: sig?.signature ?? null,
    signature_kind: sig?.signature_kind ?? null,
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
    confidence: 0.5,
  };
}
