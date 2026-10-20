// MCP server: lets any assistant (Claude, ChatGPT, Codex) drive the treasurer. Submitting an invoice goes
// through the same agent path, so the assistant has exactly the agent's powers and nothing more.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { processInvoice } from "./agent.js";
import { view, call, fmtUsdc, txHash, type Payment, type Vendor } from "./near.js";
import { config } from "./config.js";

const text = (t: unknown) => ({ content: [{ type: "text" as const, text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });

export async function runMcp() {
  const server = new McpServer({ name: "bursar", version: "0.1.0" });

  server.tool("submit_invoice", "Read an invoice PDF privately (TEE) and ask the policy contract to pay it. Returns the on-chain decision.", {
    path: z.string().describe("Path to the invoice PDF"),
    offline: z.boolean().optional().describe("Skip NEAR AI and use the offline parser (demo invoices only)"),
  }, async ({ path, offline }) => {
    const r = await processInvoice(resolve(path), { offline, direct: !config.relayerAccount && !process.env.BURSAR_RELAYER_URL });
    return text({ paymentId: r.paymentId, status: r.payment?.status, reason: r.payment?.reason, amount: fmtUsdc(r.claim.amount), vendor: r.claim.vendor_id, flags: r.claim.flags, tx: r.txHash });
  });

  server.tool("list_payments", "List payments recorded by the policy contract, newest last.", {
    limit: z.number().optional(),
  }, async ({ limit }) => {
    const ps = await view<Payment[]>("list_payments", { from: 0, limit: limit ?? 50 });
    return text(ps.map((p) => ({ id: p.id, vendor: p.vendor_id, invoice: p.invoice_number, amount: fmtUsdc(p.amount), status: p.status, reason: p.reason, dest_tx: p.dest_tx })));
  });

  server.tool("get_payment", "Full record of one payment, including the TEE attestation reference.", { id: z.number() }, async ({ id }) => {
    return text(await view<Payment | null>("get_payment", { id }));
  });

  server.tool("explain_decision", "Explain in plain words why a payment was paid, queued, sent for approval or blocked.", { id: z.number() }, async ({ id }) => {
    const p = await view<Payment | null>("get_payment", { id });
    if (!p) return text("no such payment");
    const why: Record<string, string> = {
      Paid: "The vendor is on NEAR, the amount is under every cap, so the contract paid it in the same transaction.",
      Queued: "Policy passed. The vendor is on another chain, so the executor will route USDC through NEAR Intents. The contract will only release funds to a quote whose recipient equals the vendor's recorded payout.",
      Approval: "The amount is at or above the approval threshold. A Sputnik DAO proposal was opened; a council member must approve it in Trezu.",
      Settling: "USDC left the treasury towards the Intents deposit address. Waiting for the destination chain transaction.",
      Settled: "Delivered on the destination chain.",
      Blocked: `Refused by policy: ${p.reason}.` + (({
        payout_changed: " The payout on the invoice differs from the vendor's payout recorded by the owner. This is the classic invoice fraud pattern; only the owner can change a payout.",
        duplicate_invoice: " An invoice with the same vendor and number was already accepted.",
        unknown_vendor: " The vendor is not in the allowlist.",
        over_payment_cap: " The amount exceeds the per-payment cap.",
        over_monthly_budget: " The vendor's monthly budget would be exceeded.",
        over_daily_cap: " The daily cap would be exceeded.",
        insufficient_treasury: " Not enough USDC in the treasury.",
      } as Record<string, string | undefined>)[p.reason ?? ""] ?? ""),
      Cancelled: "Cancelled by the owner or rejected by the DAO.",
    };
    return text(`Payment #${p.id}, ${fmtUsdc(p.amount)} to ${p.vendor_id} (invoice ${p.invoice_number}): ${p.status}. ${why[p.status] ?? ""}${p.flags.length ? ` Model flags: ${p.flags.join(", ")}.` : ""} Attestation: ${p.attestation_ref}`);
  });

  server.tool("vendors", "Vendors the owner allowlisted, with payout and budget.", {}, async () => {
    const vs = await view<[string, Vendor][]>("list_vendors");
    return text(vs.map(([id, v]) => ({ id, name: v.name, payout: v.payout, monthly_budget: fmtUsdc(v.monthly_budget), spent_this_month: fmtUsdc(v.spent_this_month), active: v.active })));
  });

  server.tool("treasury_status", "Balance, caps and counters.", {}, async () => {
    const [stats, limits, roles] = await Promise.all([view<any>("get_stats"), view<any>("get_limits"), view<any>("get_roles")]);
    return text({ treasury: config.treasury, balance: fmtUsdc(stats.balance), spent_today: fmtUsdc(stats.spent_today), payments: stats.payments, paused: stats.paused,
      per_payment_cap: fmtUsdc(limits.per_payment_cap), daily_cap: fmtUsdc(limits.daily_cap), approval_threshold: fmtUsdc(limits.approval_threshold),
      owner: roles[0], agent: roles[1], executor: roles[2], dao: roles[3], usdc: roles[4] });
  });

  server.tool("owner_cancel_payment", "Owner only: cancel a Queued or Approval payment. Requires the owner key in the local keystore.", { id: z.number() }, async ({ id }) => {
    const r = await call(config.treasury, "cancel_payment", { id }, 30);
    return text({ tx: txHash(r) });
  });

  await server.connect(new StdioServerTransport());
}
