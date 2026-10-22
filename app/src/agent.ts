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
import { readInvoice, readInvoiceOffline, attestationRef, type Extraction, type AiReceipt, type AttestationReport, claimFlags, claimValues, payoutProblem, clip, CLAIM_LIMITS } from "./ai.js";
import type { Payout } from "./near.js";
import { requestPaymentViaRelayer, requestPaymentDirect, view, toUnits, fmtUsdc, type InvoiceClaim, type Payment, type Vendor } from "./near.js";

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
/** 110 dpi is plenty for a born-digital PDF; a scan with no text layer gets 160, the model has only the pixels there. */
async function rasterize(pdfPath: string, dpi = 110): Promise<Buffer[]> {
  try {
    const out = join(config.state, "pages", basename(pdfPath, ".pdf"));
    await mkdir(out, { recursive: true });
    // a scan is sent as JPEG: a noisy page as PNG is several times larger and the relay caps a request at 2 MB
    await exec("pdftoppm", [...(dpi > 110 ? ["-jpeg", "-jpegopt", "quality=85"] : ["-png"]), "-r", String(dpi), "-f", "1", "-l", "2", pdfPath, join(out, "p")]);
    const files = (await readdir(out)).filter((f) => /\.(png|jpg)$/.test(f)).sort();
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
/** The vendor id the claim carries: an exact id or name, else the tax id, else a name containment (flagged `vendor_ambiguous`:
 *  "consultant" would otherwise claim "Senior Consultant Services"). Unknown vendors are still submitted: the contract
 *  records the block with reason unknown_vendor. */
export function matchVendorWith(ex: Extraction, vendors: [string, Vendor][]): { id: string; fuzzy: boolean } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const guess = norm(ex.vendor_id_guess || ex.vendor_name);
  for (const [id, v] of vendors) {
    if (norm(id) === guess || norm(v.name) === guess) return { id, fuzzy: false };
  }
  const tax = norm(ex.vendor_tax_id || "");
  if (tax) for (const [id, v] of vendors) if (v.tax_id && norm(v.tax_id) === tax) return { id, fuzzy: false };
  const hits = vendors.filter(([id, v]) => guess.length >= 4 && (guess.includes(norm(id)) || norm(v.name).includes(guess) || guess.includes(norm(v.name))));
  if (hits.length === 1) return { id: hits[0][0], fuzzy: true };
  return { id: clip(ex.vendor_id_guess || "unknown", CLAIM_LIMITS.vendor_id), fuzzy: false };
}
async function matchVendor(ex: Extraction, vendors: [string, Vendor][]): Promise<string> {
  return matchVendorWith(ex, vendors).id;
}

export interface ReadResult {
  file: string;
  invoiceHash: string;
  text: string;
  extraction: Extraction;
  /** `{ receipt, attestation }` from the TEE, or null when the offline parser was used. */
  ai: { receipt: AiReceipt; attestation: AttestationReport } | null;
  attestationRef: string;
}

/** The reading half: hash the PDF, rasterize it, read it in the TEE (or with the offline parser). No chain. */
export async function readInvoiceFile(pdfPath: string, opts: { offline?: boolean } = {}): Promise<ReadResult> {
  const bytes = await readFile(pdfPath);
  const invoiceHash = createHash("sha256").update(bytes).digest("hex");
  const text = await pdfText(pdfPath);
  if (opts.offline || !config.aiApiKey) {
    return { file: basename(pdfPath), invoiceHash, text, extraction: readInvoiceOffline(text), ai: null, attestationRef: `offline:${invoiceHash.slice(0, 16)}` };
  }
  const pages = await rasterize(pdfPath, text.trim() ? 110 : 160);
  const r = await readInvoice(pages, text.trim() ? text : undefined);
  return { file: basename(pdfPath), invoiceHash, text, extraction: r.extraction, ai: { receipt: r.receipt, attestation: r.attestation }, attestationRef: attestationRef(r.receipt) };
}

function buildClaim(read: ReadResult, vendorId: string, registeredPayout: Payout | null = null, fuzzy = false): InvoiceClaim {
  const { extraction, invoiceHash } = read;
  const values = claimValues(extraction);
  const payout = values.payout_seen;
  return {
    vendor_id: clip(vendorId, CLAIM_LIMITS.vendor_id),
    invoice_number: clip(extraction.invoice_number || "unknown", CLAIM_LIMITS.invoice_number),
    amount: toUnits(values.amount),
    due_date: clip(extraction.due_date || "", CLAIM_LIMITS.due_date),
    invoice_hash: invoiceHash,
    payout_seen: "Chain" in payout && payout.Chain ? { Chain: { chain: clip(payout.Chain.chain, CLAIM_LIMITS.chain), address: clip(payout.Chain.address, CLAIM_LIMITS.address) } } : payout,
    attestation_ref: clip(read.attestationRef, CLAIM_LIMITS.attestation_ref),
    flags: [...claimFlags(extraction, read.text, registeredPayout), ...(fuzzy ? ["vendor_ambiguous"] : [])].slice(0, CLAIM_LIMITS.flags).map((f) => clip(f, CLAIM_LIMITS.flag)),
    order_ref: extraction.order_ref?.trim() ? clip(extraction.order_ref.trim(), CLAIM_LIMITS.order_ref) : null,
    vendor_tax_id: clip((extraction.vendor_tax_id || "").trim(), CLAIM_LIMITS.tax_id),
    buyer_tax_id: clip((extraction.buyer_tax_id || "").trim(), CLAIM_LIMITS.tax_id),
    withholding_seen: toUnits(values.withholding),
  };
}

/**
 * Read one invoice and write the receipt without asking the contract for anything.
 * The receipt has the same shape as the ones the agent writes, minus `payment` and `tx`, so `bursar verify <path> --no-chain`
 * checks it. The vendor id is the model's guess: matching it against the allowlist is the contract's job, not done here.
 */
export async function readOnly(pdfPath: string, opts: { offline?: boolean } = {}): Promise<{ read: ReadResult; claim: InvoiceClaim; receiptPath: string }> {
  const read = await readInvoiceFile(pdfPath, opts);
  const claim = buildClaim(read, read.extraction.vendor_id_guess || "unknown");
  await mkdir(join(config.state, "receipts"), { recursive: true });
  const receiptPath = join(config.state, "receipts", `read-${basename(pdfPath, ".pdf")}.json`);
  await writeFile(receiptPath, JSON.stringify({ file: read.file, extraction: read.extraction, claim, tx: null, payment: null, ai: read.ai }, null, 2));
  return { read, claim, receiptPath };
}

export async function processInvoice(pdfPath: string, opts: { offline?: boolean; direct?: boolean } = {}): Promise<AgentResult> {
  const read = await readInvoiceFile(pdfPath, opts);
  const { extraction } = read;
  const receipt = read.ai;
  const vendors = await view<[string, Vendor][]>("list_vendors");
  const { id: vendorId, fuzzy } = matchVendorWith(extraction, vendors);
  const claim = buildClaim(read, vendorId, vendors.find(([id]) => id === vendorId)?.[1].payout ?? null, fuzzy);
  // An abbreviated or garbled payout would not even deserialize in the contract: a person has to read this one.
  const problem = payoutProblem(claim.payout_seen);
  if (problem) throw new Error(`not submitted: ${problem}; a person has to read this invoice`);

  const sent = opts.direct ? await requestPaymentDirect(claim) : await requestPaymentViaRelayer(claim);
  // The view may lag the transaction by a block on some RPC nodes: retry briefly instead of recording null.
  let payment: Payment | null = null;
  for (let i = 0; i < 5 && !payment; i++) {
    payment = await view<Payment | null>("get_payment", { id: sent.paymentId });
    if (!payment) await new Promise((r) => setTimeout(r, 1500));
  }

  await mkdir(join(config.state, "receipts"), { recursive: true });
  await writeFile(
    join(config.state, "receipts", `${sent.paymentId}.json`),
    JSON.stringify({ file: basename(pdfPath), extraction, claim, tx: sent.txHash, payment, ai: receipt }, null, 2),
  );
  return { file: basename(pdfPath), extraction, claim, paymentId: sent.paymentId, txHash: sent.txHash, payment };
}

// ---------- invoices approved from Telegram ----------
// The relay keeps the inbox; the owner's chat gets every invoice with Approve and Reject. An approved one is taken here,
// read like a dropped file and submitted; the outcome goes back to the relay, which tells the chats.
interface InboxItem { id: string; name: string; status: string; vendor: string; chat: number | string; from: string }
const relayOn = () => !!(config.relay && config.inboxToken);
async function relay(path: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(`${config.relay}${path}`, { ...init, headers: { Authorization: `Bearer ${config.inboxToken}`, "content-type": "application/json", ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`relay ${path} ${r.status}: ${(await r.json().catch(() => ({}))).error || ""}`);
  return r;
}
const telegramTries = new Map<string, { path: string; tries: number }>();
/** One pass over the relay inbox: take what was approved, read and submit it, report. Errors are retried on later ticks, three times. */
async function telegramTick(opts: { offline?: boolean; direct?: boolean }) {
  const q = `treasury=${encodeURIComponent(config.treasury)}`;
  const { items } = (await (await relay(`/inbox/list?${q}`)).json()) as { items: InboxItem[] };
  for (const it of items.filter((x) => x.status === "approved" || telegramTries.has(x.id))) {
    let job = telegramTries.get(it.id);
    try {
      if (!job) {
        const taken = await relay("/inbox/take", { method: "POST", body: JSON.stringify({ treasury: config.treasury, id: it.id }) });
        if (!taken.ok) continue;
        const dir = join(config.state, "telegram");
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${it.id.replace(/[^\w-]/g, "_")}-${basename(it.name).replace(/[^\w.-]/g, "_")}`);
        const pdf = await relay(`/inbox/file?${q}&id=${encodeURIComponent(it.id)}`);
        await writeFile(path, Buffer.from(await pdf.arrayBuffer()));
        job = { path, tries: 0 };
        telegramTries.set(it.id, job);
      }
      job.tries++;
      const r = await processInvoice(job.path, opts);
      const p = r.payment;
      const vendorName = (await view<[string, Vendor][]>("list_vendors").catch(() => [] as [string, Vendor][])).find(([id]) => id === r.claim.vendor_id)?.[1].name || r.claim.vendor_id;
      console.log(`[agent] telegram ${it.name} -> payment #${r.paymentId} ${p?.status}${p?.reason ? " (" + p.reason + ")" : ""}`);
      telegramTries.delete(it.id);
      await relay("/inbox/outcome", { method: "POST", body: JSON.stringify({ treasury: config.treasury, id: it.id, payment_id: r.paymentId, status: p?.status ?? "decided", reason: p?.reason ?? null, vendor: vendorName, invoice_number: r.claim.invoice_number, amount: fmtUsdc(r.claim.amount), tx_url: `${config.explorer}/txns/${r.txHash}` }) });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[agent] telegram ${it.name} failed (${job?.tries ?? 0}/3): ${msg}`);
      if (job && job.tries >= 3) {
        telegramTries.delete(it.id);
        await relay("/inbox/outcome", { method: "POST", body: JSON.stringify({ treasury: config.treasury, id: it.id, status: "error", message: msg.slice(0, 200) }) }).catch(() => {});
      }
    }
  }
}

/** Poll the inbox folder, and the relay's Telegram inbox when BURSAR_RELAY and BURSAR_INBOX_TOKEN are set. Processed files move to inbox/done. */
export async function watchInbox(opts: { offline?: boolean; direct?: boolean; once?: boolean } = {}) {
  const inbox = config.inbox;
  const done = join(inbox, "done");
  await mkdir(done, { recursive: true });
  // a file that failed (RPC hiccup, a quota, the gateway) is tried again on later ticks, three times, then parked
  const failures = new Map<string, number>();
  const parked = join(inbox, "failed");
  const tick = async () => {
    if (relayOn()) await telegramTick(opts).catch((e) => console.error("[agent] telegram inbox:", (e as Error).message));
    if (!existsSync(inbox)) return;
    for (const f of (await readdir(inbox)).filter((f) => f.toLowerCase().endsWith(".pdf")).sort()) {
      const p = join(inbox, f);
      try {
        const r = await processInvoice(p, opts);
        console.log(`[agent] ${f} -> payment #${r.paymentId} ${r.payment?.status}${r.payment?.reason ? " (" + r.payment.reason + ")" : ""}`);
        failures.delete(f);
        await rename(p, join(done, f));
      } catch (e) {
        const n = (failures.get(f) ?? 0) + 1;
        failures.set(f, n);
        console.error(`[agent] ${f} failed (${n}/3):`, (e as Error).message);
        if (n >= 3) { await mkdir(parked, { recursive: true }); await rename(p, join(parked, f)); failures.delete(f); console.error(`[agent] ${f} parked in inbox/failed`); }
      }
    }
  };
  await tick();
  if (opts.once) return;
  setInterval(tick, 3000);
  console.log(`[agent] watching ${inbox}${relayOn() ? ` and the Telegram inbox on ${config.relay}` : ""}`);
}
