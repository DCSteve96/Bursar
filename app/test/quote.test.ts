import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { ONE_CLICK_SIGNER, signedPayload, stableStringify } from "../src/quote.js";

describe("1Click quote payload", () => {
  it("rebuilds the bytes 1Click signed: a real quote verifies against 1Click's key", () => {
    const q = JSON.parse(readFileSync(new URL("./fixtures/quote-dry-1click.json", import.meta.url), "utf8"));
    const payload = signedPayload(q)!;
    expect(payload).toBeTruthy();
    const message = base58.encode(new Uint8Array(createHash("sha256").update(payload).digest()));
    const sig = base58.decode(q.signature.replace(/^ed25519:/, ""));
    const pk = base58.decode(ONE_CLICK_SIGNER.replace(/^ed25519:/, ""));
    expect(ed25519.verify(sig, new TextEncoder().encode(message), pk)).toBe(true);
    expect(stableStringify({ b: 1, a: undefined, c: "x" })).toBe('{"b":1,"c":"x"}');
  });
});
