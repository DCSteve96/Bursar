// The agent: watches the inbox, reads each invoice privately, and asks the policy contract for a payment.
// It holds one function-call key that can only call `request_payment`. It never sees vendor payout records,
// never chooses an address, and never holds NEAR (gas goes through the relayer).
import { readdir, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { readInvoice, readInvoiceOffline, attestationRef, type Extraction } from "./ai.js";
import { requestPaymentViaRelayer, requestPaymentDirect, view, toUnits, type InvoiceClaim, type Payment, type Vendor } from "./near.js";

const exec = promisify(execFile);

export interface AgentResult {
  file: string;
  extraction: Extraction;
  claim: InvoiceClaim;
  paymentId: number;
  txHash: string;
  payment: Payment | null;
}

/** Rasterize a PDF to PNG pages with pdftoppm (poppler). Falls back to text only if poppler is missing. */
async function rasterize(pdfPath: string): Promise<Buffer[]> {
  try {
    const out = join(config.state, "pages", basename(pdfPath, ".pdf"));
    await mkdir(out, { recursive: true });
    await exec("pdftoppm", ["-png", "-r", "110", "-f", "1", "-l", "2", pdfPath, join(out, "p")]);
    const files = (await readdir(out)).filter((f) => f.endsWith(".png")).sort();
    return Promise.all(files.map((f) => readFile(join(out, f))));
  } catch {
    return [];
  }
}

async function pdfText(pdfPath: string): Promise<string> {
  try {
    const { stdout } = await exec("pdftotext", ["-layout", pdfPath, "-"]);
    if (stdout.trim()) return stdout;
  } catch {}
  try {
    const mod: any = await import("pdf-parse");
    const pdfParse = mod.default ?? mod;
    const data = await pdfParse(await readFile(pdfPath));
    return String(data.text ?? "");
  } catch {
    return "";
  }
}

/** Map the model's vendor guess to a vendor id known by the contract (by id or by name, case-insensitive). */
async function matchVendor(ex: Extraction): Promise<string> {
  const vendors = await view<[string, Vendor][]>("list_vendors");
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const guess = norm(ex.vendor_id_guess || ex.vendor_name);
  for (const [id, v] of vendors) {
    if (norm(id) === guess || norm(v.name) === guess) return id;
  }
  for (const [id, v] of vendors) {
    if (guess.includes(norm(id)) || norm(v.name).includes(guess) || guess.includes(norm(v.name))) return id;
  }
  // Unknown vendors are still submitted: the contract records the block with reason unknown_vendor.
  return ex.vendor_id_guess || "unknown";
}

export async function processInvoice(pdfPath: string, opts: { offline?: boolean; direct?: boolean } = {}): Promise<AgentResult> {
  const bytes = await readFile(pdfPath);
  const invoiceHash = createHash("sha256").update(bytes).digest("hex");
  const text = await pdfText(pdfPath);

  let extraction: Extraction;
  let ref: string;
  let receipt: unknown = null;
  if (opts.offline || !config.aiApiKey) {
    extraction = readInvoiceOffline(text);
    ref = `offline:${invoiceHash.slice(0, 16)}`;
  } else {
    const pages = await rasterize(pdfPath);
    const r = await readInvoice(pages, text);
    extraction = r.extraction;
    receipt = { receipt: r.receipt, attestation: r.attestation };
    ref = attestationRef(r.receipt);
  }

  const vendorId = await matchVendor(extraction);
  const claim: InvoiceClaim = {
    vendor_id: vendorId,
    invoice_number: extraction.invoice_number || "unknown",
    amount: toUnits(extraction.amount || "0"),
    due_date: extraction.due_date || "",
    invoice_hash: invoiceHash,
    payout_seen: extraction.payout_seen,
    attestation_ref: ref,
    flags: extraction.flags ?? [],
  };

  const sent = opts.direct ? await requestPaymentDirect(claim) : await requestPaymentViaRelayer(claim);
  const payment = await view<Payment | null>("get_payment", { id: sent.paymentId });

  await mkdir(join(config.state, "receipts"), { recursive: true });
  await writeFile(
    join(config.state, "receipts", `${sent.paymentId}.json`),
    JSON.stringify({ file: basename(pdfPath), extraction, claim, tx: sent.txHash, payment, ai: receipt }, null, 2),
  );
  return { file: basename(pdfPath), extraction, claim, paymentId: sent.paymentId, txHash: sent.txHash, payment };
}

/** Poll the inbox folder. Processed files move to inbox/done. */
export async function watchInbox(opts: { offline?: boolean; direct?: boolean; once?: boolean } = {}) {
  const inbox = config.inbox;
  const done = join(inbox, "done");
  await mkdir(done, { recursive: true });
  const seen = new Set<string>();
  const tick = async () => {
    if (!existsSync(inbox)) return;
    for (const f of (await readdir(inbox)).filter((f) => f.toLowerCase().endsWith(".pdf")).sort()) {
      if (seen.has(f)) continue;
      seen.add(f);
      const p = join(inbox, f);
      try {
        const r = await processInvoice(p, opts);
        console.log(`[agent] ${f} -> payment #${r.paymentId} ${r.payment?.status}${r.payment?.reason ? " (" + r.payment.reason + ")" : ""}`);
        await rename(p, join(done, f));
      } catch (e) {
        console.error(`[agent] ${f} failed:`, (e as Error).message);
      }
    }
  };
  await tick();
  if (opts.once) return;
  setInterval(tick, 3000);
  console.log(`[agent] watching ${inbox}`);
}
