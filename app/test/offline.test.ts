import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readInvoiceOffline } from "../src/ai.js";

const text = (f: string) => execFileSync("pdftotext", ["-layout", resolve(__dirname, "..", "..", "invoices", "samples", f), "-"]).toString();

describe("offline parser on the sample invoices", () => {
  it("reads the four demo invoices", () => {
    const a = readInvoiceOffline(text("01-acme-hosting-0923.pdf"));
    expect(a.amount).toBe("480.00");
    expect(a.invoice_number).toBe("AH-0923");
    expect("Near" in a.payout_seen).toBe(true);
    const b = readInvoiceOffline(text("02-designco-1107.pdf"));
    expect(b.amount).toBe("1250.00");
    expect("Chain" in b.payout_seen && b.payout_seen.Chain.chain).toBe("base");
    const c = readInvoiceOffline(text("03-legalpartners-2210.pdf"));
    expect(c.amount).toBe("9800.00");
    const d = readInvoiceOffline(text("04-acme-hosting-0924-fraud.pdf"));
    expect(d.flags).toContain("new_payment_details");
  });
});
