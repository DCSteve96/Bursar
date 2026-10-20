#!/usr/bin/env node
// bursar <command>
//   agent [--once] [--offline] [--direct]   watch the inbox and submit invoices
//   submit <file.pdf> [--offline] [--direct] submit one invoice
//   executor [--once]                        route Queued payments through NEAR Intents (mainnet)
//   relayer                                  pay gas for the agent's meta transactions
//   mcp                                      run the MCP server on stdio
//   status                                   print treasury status and payments
import { config } from "./config.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f: string) => rest.includes(f);

async function main() {
  switch (cmd) {
    case "agent": {
      const { watchInbox } = await import("./agent.js");
      await watchInbox({ once: flag("--once"), offline: flag("--offline"), direct: flag("--direct") });
      break;
    }
    case "submit": {
      const file = rest.find((a) => !a.startsWith("--"));
      if (!file) throw new Error("usage: bursar submit <file.pdf>");
      const { processInvoice } = await import("./agent.js");
      const r = await processInvoice(file, { offline: flag("--offline"), direct: flag("--direct") });
      console.log(JSON.stringify({ paymentId: r.paymentId, status: r.payment?.status, reason: r.payment?.reason, tx: r.txHash, claim: r.claim }, null, 2));
      break;
    }
    case "executor": {
      const { runExecutor } = await import("./executor.js");
      await runExecutor({ once: flag("--once") });
      break;
    }
    case "relayer": {
      const { runRelayer } = await import("./relayer.js");
      await runRelayer();
      break;
    }
    case "mcp": {
      const { runMcp } = await import("./mcp.js");
      await runMcp();
      break;
    }
    case "setup": {
      const root = rest[rest.indexOf("--root") + 1];
      if (!root || root.startsWith("--")) throw new Error("usage: bursar setup --root <account> [--mainnet] [--no-dao] [--prefix x-] [--usdc <ft contract>]");
      const { setup } = await import("./setup.js");
      const usdcIdx = rest.indexOf("--usdc");
      const prefixIdx = rest.indexOf("--prefix");
      await setup({
        root,
        network: flag("--mainnet") ? "mainnet" : "testnet",
        dao: !flag("--no-dao"),
        prefix: prefixIdx >= 0 ? rest[prefixIdx + 1] : "",
        usdc: usdcIdx >= 0 ? rest[usdcIdx + 1] : undefined,
      });
      break;
    }
    case "status": {
      const { view, fmtUsdc } = await import("./near.js");
      const [stats, limits, payments] = await Promise.all([view<any>("get_stats"), view<any>("get_limits"), view<any[]>("list_payments", { from: 0, limit: 100 })]);
      console.log(`treasury ${config.treasury} on ${config.network}`);
      console.log(`balance ${fmtUsdc(stats.balance)}  spent today ${fmtUsdc(stats.spent_today)}  paused ${stats.paused}`);
      console.log(`caps: per payment ${fmtUsdc(limits.per_payment_cap)}, daily ${fmtUsdc(limits.daily_cap)}, approval from ${fmtUsdc(limits.approval_threshold)}`);
      for (const p of payments) console.log(`#${p.id} ${p.vendor_id} ${p.invoice_number} ${fmtUsdc(p.amount)} ${p.status}${p.reason ? " " + p.reason : ""}${p.dest_tx ? " " + p.dest_tx : ""}`);
      break;
    }
    default:
      console.log("usage: bursar setup|agent|submit|executor|relayer|mcp|status");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
