// Independent verification of a Bursar AI receipt. Needs no NEAR AI API key and does not trust the agent.
//
// What it proves, step by step:
//   1. The signed text is `<model>:<sha256(request)>:<sha256(response)>` over the exact bytes in the receipt.
//   2. The ECDSA signature (Ethereum style, EIP-191) recovers to the signing address in the receipt.
//   3. The signature kind is `provider_tee`: the signer is the model's TEE, not the gateway.
//   4. The attestation report fetched before the call contains that signing address, echoes our nonce,
//      and its Intel TDX quote binds both in `report_data` (address in bytes 0..20, nonce in bytes 32..64).
//   5. The TDX quote verifies against Intel collateral (certificate chain, TCB status). Needs the network.
//   6. The extraction the agent acted on is exactly what the model returned in that response.
//   7. Optional: the payment on chain carries the attestation reference derived from this receipt.
//
// Not covered yet: replay of the RTMR3 event log against the quote (which images and compose file ran).
// The receipt keeps `event_log`, so it can be added without re-running anything.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { Quote, getCollateral, verify as verifyQuote, PHALA_PCCS_URL } from "@phala/dcap-qvl";
import { config } from "./config.js";
import { attestationRef, sha256, type AiReceipt, type AttestationReport, type ModelAttestation } from "./ai.js";

export interface Check {
  name: string;
  ok: boolean | null; // null = skipped
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: Check[];
}

export interface ReceiptFile {
  file?: string;
  extraction?: unknown;
  claim?: { attestation_ref?: string; invoice_hash?: string };
  payment?: { id?: number; attestation_ref?: string } | null;
  ai: { receipt: AiReceipt; attestation: AttestationReport } | null;
}

const hex = (s: string) => Buffer.from(s.replace(/^0x/i, ""), "hex");

/** EIP-191 personal message hash, as `ethers.verifyMessage` computes it. */
export function eip191Hash(text: string): Uint8Array {
  const msg = Buffer.from(text, "utf8");
  return keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, "utf8"), msg]));
}

/** Recover the Ethereum address that produced a 65-byte (r, s, v) signature over `text`. */
export function recoverAddress(text: string, signatureHex: string): string {
  const sig = hex(signatureHex);
  if (sig.length !== 65) throw new Error(`signature is ${sig.length} bytes, expected 65`);
  let v = sig[64];
  if (v >= 27) v -= 27;
  const s = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(v);
  const pub = s.recoverPublicKey(eip191Hash(text)).toBytes(false);
  return "0x" + Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString("hex");
}

function pick(att: AttestationReport, signingAddress: string): ModelAttestation | undefined {
  const want = signingAddress.toLowerCase().replace(/^0x/, "");
  return att.model_attestations?.find((m) => m.signing_address.toLowerCase().replace(/^0x/, "") === want);
}

export async function verifyReceipt(rf: ReceiptFile, opts: { collateral?: boolean; pccsUrl?: string; chain?: boolean } = {}): Promise<VerifyResult> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean | null, detail: string) => checks.push({ name, ok, detail });
  if (!rf.ai) {
    add("receipt", false, "no AI receipt in this record (offline parser was used)");
    return { ok: false, checks };
  }
  const r = rf.ai.receipt;

  // 1. signed text over exact bytes
  let model = r.model;
  try {
    model = JSON.parse(r.request_body).model ?? r.model;
  } catch {}
  const expected = `${model}:${sha256(r.request_body)}:${sha256(r.response_body)}`;
  add("bytes", r.request_sha256 === sha256(r.request_body) && r.response_sha256 === sha256(r.response_body), "request and response hashes match the stored bytes");
  if (!r.signed_text || !r.signature || !r.signing_address) {
    add("signature", false, "the gateway returned no signature for this completion (receipt was taken without one)");
  } else {
    add("signed_text", r.signed_text === expected, r.signed_text === expected ? `signed text is ${expected.slice(0, 40)}...` : `gateway signed "${r.signed_text}" but the bytes give "${expected}"`);
    // 2. recover signer
    try {
      const rec = recoverAddress(r.signed_text, r.signature);
      const ok = rec.toLowerCase() === r.signing_address.toLowerCase();
      add("signature", ok, ok ? `ECDSA signature recovers to ${rec}` : `signature recovers to ${rec}, receipt says ${r.signing_address}`);
    } catch (e) {
      add("signature", false, `cannot recover signer: ${(e as Error).message}`);
    }
    // 3. kind
    add("signer_kind", r.signature_kind === "provider_tee", r.signature_kind === "provider_tee" ? "signed inside the model TEE (provider_tee)" : `signature kind is ${r.signature_kind}: the gateway signed, not the model enclave`);
  }

  // 4. attestation binding
  const att = rf.ai.attestation;
  const m = r.signing_address ? pick(att, r.signing_address) : undefined;
  if (!m) {
    add("attestation", false, att.error ? `attestation fetch failed: ${att.error}` : "no model attestation carries the signing address");
  } else {
    add("attestation_signer", true, `attestation report lists signer ${m.signing_address}`);
    add("attestation_nonce", m.request_nonce.toLowerCase() === r.attestation_nonce.toLowerCase(), m.request_nonce.toLowerCase() === r.attestation_nonce.toLowerCase() ? "report echoes our fresh nonce" : "nonce mismatch: the report was not produced for this request");
    let quoteBytes: Buffer | null = null;
    try {
      quoteBytes = hex(m.intel_quote);
      const q = Quote.parse(quoteBytes);
      const td = q.report.asTd10() ?? q.report.asTd15()?.base ?? q.report.asTd15Ex()?.base.base ?? null;
      if (!td) {
        add("quote_report_data", false, `quote is ${q.report.type}, not a TDX report`);
      } else {
        const rd = Buffer.from(td.reportData);
        const addr = hex(m.signing_address);
        const addrOk = rd.subarray(0, 20).equals(addr) && rd.subarray(20, 32).every((b) => b === 0);
        const nonceOk = rd.subarray(32, 64).equals(hex(r.attestation_nonce));
        add("quote_report_data", addrOk && nonceOk, addrOk && nonceOk ? `TDX quote report_data binds signer and nonce (mrtd ${Buffer.from(td.mrTd).toString("hex").slice(0, 16)}...)` : `report_data does not bind ${addrOk ? "nonce" : "signer"}`);
      }
    } catch (e) {
      add("quote_report_data", false, `cannot parse intel_quote: ${(e as Error).message}`);
    }
    // 5. collateral
    if (opts.collateral === false) {
      add("quote_tcb", null, "skipped (no network): run without --no-collateral to check the quote against Intel collateral");
    } else if (quoteBytes) {
      try {
        const collateral = await getCollateral(opts.pccsUrl ?? PHALA_PCCS_URL, quoteBytes);
        const v = verifyQuote(quoteBytes, collateral, Math.floor(Date.now() / 1000));
        const good = v.status === "UpToDate" || v.status === "SWHardeningNeeded";
        add("quote_tcb", good, `quote verified against Intel collateral: TCB ${v.status}${v.advisory_ids.length ? ` (${v.advisory_ids.join(", ")})` : ""}`);
      } catch (e) {
        add("quote_tcb", false, `quote verification failed: ${(e as Error).message}`);
      }
    }
  }

  // 6. the extraction is what the model said
  try {
    const completion = JSON.parse(r.response_body);
    const said = JSON.parse(completion.choices?.[0]?.message?.content ?? "{}");
    const same = JSON.stringify(said) === JSON.stringify(rf.extraction);
    add("extraction", same, same ? "the claim was built from exactly this model output" : "the stored extraction differs from the model output in the signed response");
    add("completion_id", completion.id === r.inference_id, `completion id ${completion.id}`);
  } catch (e) {
    add("extraction", false, `cannot parse response: ${(e as Error).message}`);
  }

  // 7. on chain
  const ref = attestationRef(r);
  add("attestation_ref", rf.claim?.attestation_ref === ref, rf.claim?.attestation_ref === ref ? `claim carries ${ref.slice(0, 48)}...` : "the claim's attestation_ref was not derived from this receipt");
  if (opts.chain !== false && rf.payment?.id !== undefined) {
    try {
      const { view } = await import("./near.js");
      const p = await view<{ attestation_ref: string; invoice_hash: string } | null>("get_payment", { id: rf.payment.id });
      add("on_chain", !!p && p.attestation_ref === ref, p ? (p.attestation_ref === ref ? `payment #${rf.payment.id} on ${config.treasury} carries this reference` : "on-chain payment carries a different attestation_ref") : "payment not found on chain");
    } catch (e) {
      add("on_chain", null, `skipped: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  return { ok: checks.every((c) => c.ok !== false), checks };
}

/** Load a receipt by payment id (from the local state folder) or by path. */
export async function loadReceipt(idOrPath: string): Promise<ReceiptFile> {
  const path = /^\d+$/.test(idOrPath) ? join(config.state, "receipts", `${idOrPath}.json`) : idOrPath;
  return JSON.parse(await readFile(path, "utf8")) as ReceiptFile;
}

export function formatResult(v: VerifyResult): string {
  const lines = v.checks.map((c) => `${c.ok === null ? "  -  " : c.ok ? " ok  " : "FAIL "}${c.name.padEnd(20)} ${c.detail}`);
  lines.push(v.ok ? "verified: the decision was made on this model output, inside an attested TEE" : "NOT verified");
  return lines.join("\n");
}
