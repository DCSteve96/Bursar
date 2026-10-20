import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { eip191Hash, recoverAddress, verifyReceipt, type ReceiptFile } from "../src/verify.js";
import { attestationRef, sha256, type AiReceipt } from "../src/ai.js";

// A synthetic "TEE": a random secp256k1 key that signs like the NEAR AI gateway does (EIP-191 over the text).
const priv = secp256k1.utils.randomSecretKey();
const pub = secp256k1.getPublicKey(priv, false);
const signer = "0x" + Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString("hex");
const sign = (text: string) => {
  const s = secp256k1.sign(eip191Hash(text), priv, { prehash: false, format: "recovered" });
  return Buffer.concat([Buffer.from(s.subarray(1)), Buffer.from([27 + s[0]])]).toString("hex");
};

function receipt(tamper?: (r: AiReceipt) => void): ReceiptFile {
  const extraction = { vendor_name: "Acme Hosting", vendor_id_guess: "acmehosting", invoice_number: "AH-0923", amount: "480.00", currency: "USDC", due_date: "2026-11-30", payout_seen: { Near: { account: "acmehosting.test" } }, flags: [], confidence: 0.9 };
  const request_body = JSON.stringify({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "Read this invoice." }] });
  const response_body = JSON.stringify({ id: "chatcmpl-1", model: "z-ai/glm-5.3-flash", choices: [{ message: { role: "assistant", content: JSON.stringify(extraction) } }] });
  const nonce = "11".repeat(32);
  const signed_text = `z-ai/glm-5.3-flash:${sha256(request_body)}:${sha256(response_body)}`;
  const r: AiReceipt = {
    model: "z-ai/glm-5.3-flash", inference_id: "chatcmpl-1",
    request_sha256: sha256(request_body), response_sha256: sha256(response_body),
    attestation_nonce: nonce, signing_address: signer, signing_algo: "ecdsa",
    signature: sign(signed_text), signature_kind: "provider_tee", signed_text, request_body, response_body,
  };
  tamper?.(r);
  return {
    extraction,
    claim: { attestation_ref: attestationRef(r) },
    payment: null,
    ai: { receipt: r, attestation: { model_attestations: [{ request_nonce: nonce, signing_algo: "ecdsa", signing_address: signer, intel_quote: "00" }] } },
  };
}

const by = (checks: { name: string; ok: boolean | null }[], name: string) => checks.find((c) => c.name === name)?.ok;

describe("recoverAddress", () => {
  it("recovers the Ethereum address of a known key", () => {
    const k = Buffer.alloc(32); k[31] = 1;
    const p = secp256k1.getPublicKey(k, false);
    const a = "0x" + Buffer.from(keccak_256(p.subarray(1))).subarray(12).toString("hex");
    expect(a).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    const s = secp256k1.sign(eip191Hash("hello"), k, { prehash: false, format: "recovered" });
    const eth = Buffer.concat([Buffer.from(s.subarray(1)), Buffer.from([27 + s[0]])]).toString("hex");
    expect(recoverAddress("hello", eth)).toBe(a);
  });
});

describe("verifyReceipt", () => {
  it("accepts a receipt whose signature covers the exact bytes", async () => {
    const v = await verifyReceipt(receipt(), { collateral: false, chain: false });
    expect(by(v.checks, "bytes")).toBe(true);
    expect(by(v.checks, "signed_text")).toBe(true);
    expect(by(v.checks, "signature")).toBe(true);
    expect(by(v.checks, "signer_kind")).toBe(true);
    expect(by(v.checks, "attestation_nonce")).toBe(true);
    expect(by(v.checks, "extraction")).toBe(true);
    expect(by(v.checks, "attestation_ref")).toBe(true);
    // "00" is not a quote: the quote check must fail loudly, never pass silently
    expect(by(v.checks, "quote_report_data")).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("rejects a response that was edited after signing", async () => {
    const v = await verifyReceipt(receipt((r) => { r.response_body = r.response_body.replace("480.00", "4800.00"); r.response_sha256 = sha256(r.response_body); }), { collateral: false, chain: false });
    expect(by(v.checks, "signed_text")).toBe(false);
    expect(by(v.checks, "extraction")).toBe(false);
  });

  it("rejects a signature from another key", async () => {
    const other = secp256k1.utils.randomSecretKey();
    const v = await verifyReceipt(receipt((r) => {
      const s = secp256k1.sign(eip191Hash(r.signed_text!), other, { prehash: false, format: "recovered" });
      r.signature = Buffer.concat([Buffer.from(s.subarray(1)), Buffer.from([27 + s[0]])]).toString("hex");
    }), { collateral: false, chain: false });
    expect(by(v.checks, "signature")).toBe(false);
  });

  it("rejects an attestation made for another nonce", async () => {
    const v = await verifyReceipt(receipt((r) => { r.attestation_nonce = "22".repeat(32); }), { collateral: false, chain: false });
    expect(by(v.checks, "attestation_nonce")).toBe(false);
  });

  it("flags a gateway signature as not a model TEE proof", async () => {
    const v = await verifyReceipt(receipt((r) => { r.signature_kind = "gateway"; }), { collateral: false, chain: false });
    expect(by(v.checks, "signer_kind")).toBe(false);
  });
});
