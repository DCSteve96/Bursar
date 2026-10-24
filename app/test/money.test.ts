import { describe, expect, it } from "vitest";
import { claimValues, parseMoney, MAX_AMOUNT, type Extraction } from "../src/ai.js";
import { toUnits } from "../src/near.js";

describe("printed money", () => {
  it("reads both conventions", () => {
    expect(parseMoney("1,250.00")).toBe(1250);
    expect(parseMoney("1.250,00")).toBe(1250);
    expect(parseMoney("480.00")).toBe(480);
    expect(parseMoney("480,00")).toBe(480);
    expect(parseMoney("12.5")).toBe(12.5);
    expect(parseMoney("1.250.000")).toBe(1250000);
    expect(parseMoney("1,250,000")).toBe(1250000);
  });
  it("takes a lone separator before three digits as thousands (audit L1)", () => {
    expect(parseMoney("1.250")).toBe(1250);
    expect(parseMoney("1,250")).toBe(1250);
    expect(parseMoney("9.800")).toBe(9800);
  });
});

const ex = (over: Partial<Extraction>): Extraction => ({ vendor_name: "x", vendor_id_guess: "x", invoice_number: "1", amount: "1.00", due_date: "", payout_seen: { Near: { account: "x.testnet" } }, flags: [], ...over } as Extraction);

describe("claim amounts", () => {
  it("clips a runaway number instead of producing an unparseable amount (audit L2)", () => {
    expect(claimValues(ex({ amount: "99999999999999999999999.00", amount_printed: "$ 99,999,999,999,999,999,999,999.00" })).amount).toBe(MAX_AMOUNT.toFixed(2));
    expect(claimValues(ex({ amount: "99999999999999999999999" })).amount).toBe(MAX_AMOUNT.toFixed(2));
    expect(() => toUnits(claimValues(ex({ amount: "99999999999999999999999.00" })).amount)).not.toThrow();
    expect(() => toUnits((1e23).toFixed(2))).toThrow(); // what the clip prevents: "1e+23"
  });
  it("toUnits accepts only a plain decimal", () => {
    expect(toUnits("1250.5")).toBe("1250500000");
    expect(toUnits("1,250.00")).toBe("1250000000");
    expect(() => toUnits("1e+21")).toThrow();
    expect(() => toUnits("NaN")).toThrow();
    expect(() => toUnits("-5")).toThrow();
    expect(() => toUnits("")).toThrow();
  });
});
