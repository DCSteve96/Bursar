// The executor: no AI, company key. For every Queued payment it asks NEAR Intents for a quote whose
// recipient is the vendor's payout recorded on chain, then calls `settle`. The contract re-checks the
// recipient before releasing USDC to the Intents deposit address. Intents 1-Click runs on mainnet only.
// The contract moves exactly the net amount (invoice less withholding) to the deposit address, so the quote is
// EXACT_INPUT on that net: the vendor receives it less the bridge fee, which is capped here at 2 percent.
import { OpenAPI, OneClickService, QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { config, USDC_ASSET } from "./config.js";
import { call, view, txHash, type Payment, type Vendor } from "./near.js";
import { getTransactionLastResult } from "near-api-js";

OpenAPI.BASE = config.oneClickUrl;
if (config.oneClickJwt) OpenAPI.TOKEN = config.oneClickJwt;

const MAX_FEE_BPS = 200n;
const MAX_TRIES = 3;
const tries = new Map<number, number>(); // payment id -> failed settle attempts; after MAX_TRIES the executor stops and says so once

const netOf = (p: Payment) => BigInt(p.amount) - BigInt(p.withheld ?? "0");

async function quoteFor(p: Payment, v: Vendor) {
  if (!("Chain" in v.payout)) throw new Error("near vendors are paid directly by the contract");
  const { chain, address } = v.payout.Chain;
  const dest = USDC_ASSET[chain];
  if (!dest) throw new Error(`no USDC asset id for chain ${chain}`);
  return OneClickService.getQuote({
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT, // the contract sends exactly the net amount to the deposit address
    slippageTolerance: 50,
    originAsset: USDC_ASSET.near,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    destinationAsset: dest,
    amount: netOf(p).toString(),
    recipient: address,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    refundTo: config.treasury,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
    referral: "bursar",
  } as any);
}

export async function settleQueued(): Promise<void> {
  const payments = await view<Payment[]>("list_payments", { from: 0, limit: 200 });
  for (const p of payments.filter((x) => x.status === "Queued")) {
    if ((tries.get(p.id) ?? 0) >= MAX_TRIES) continue;
    const v = await view<Vendor | null>("get_vendor", { vendor_id: p.vendor_id });
    if (!v) continue;
    try {
      const q = await quoteFor(p, v);
      const deposit = q.quote.depositAddress!;
      const net = netOf(p);
      const amountOut = BigInt(q.quote.amountOut ?? q.quote.minAmountOut ?? "0");
      if (BigInt(q.quote.amountIn) !== net) throw new Error(`quote takes ${q.quote.amountIn}, the contract sends ${net}`);
      if (amountOut < net - net * MAX_FEE_BPS / 10_000n) throw new Error(`quote delivers ${amountOut} of ${net}, fee over ${MAX_FEE_BPS} bps`);
      console.log(`[executor] #${p.id} ${net} -> ${(v.payout as any).Chain.chain}:${(v.payout as any).Chain.address} via ${deposit}, vendor receives ${amountOut}`);
      const r = await call(config.executorAccount, "settle", {
        id: p.id,
        quote_id: q.correlationId,
        deposit_address: deposit,
        recipient: v.payout,
      }, 60);
      await OneClickService.submitDepositTx({ depositAddress: deposit, txHash: txHash(r) } as any).catch(() => {});
      tries.delete(p.id);
    } catch (e) {
      const n = (tries.get(p.id) ?? 0) + 1;
      tries.set(p.id, n);
      console.error(`[executor] #${p.id} settle attempt ${n}/${MAX_TRIES} failed:`, (e as Error).message);
      if (n >= MAX_TRIES) console.error(`[executor] ALERT #${p.id} stays Queued: ${MAX_TRIES} attempts failed, the executor stops trying it; the owner cancels it or restarts the executor after fixing the cause`);
    }
  }
}

export async function confirmSettling(): Promise<void> {
  const payments = await view<Payment[]>("list_payments", { from: 0, limit: 200 });
  for (const p of payments.filter((x) => x.status === "Settling" && x.deposit_address)) {
    try {
      const s: any = await OneClickService.getExecutionStatus(p.deposit_address!);
      if (s.status === "SUCCESS") {
        const tx = s.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? s.swapDetails?.destinationChainTxHashes?.[0] ?? "unknown";
        await call(config.executorAccount, "mark_settled", { id: p.id, dest_tx: String(tx) }, 30);
        console.log(`[executor] #${p.id} settled on destination: ${tx}`);
      } else if (s.status === "REFUNDED" || s.status === "FAILED") {
        // Intents sent the USDC back with a plain transfer. The contract takes the net back into its balance and puts the
        // payment in front of a person (Approval, reason settlement_failed): nothing is re-sent on its own, the owner
        // approves it again or cancels it from the console.
        await call(config.executorAccount, "mark_settlement_failed", { id: p.id }, 30);
        console.error(`[executor] ALERT #${p.id} ${s.status}: funds refunded to ${config.treasury}; the payment waits for the owner (approve again to retry, or cancel). If the refund did not arrive, the owner presses Sync balance first`);
      }
    } catch (e) {
      console.error(`[executor] #${p.id} status failed:`, (e as Error).message);
    }
  }
}

/**
 * Sputnik does not call back when the council rejects a proposal or lets it expire. For every payment
 * waiting for approval, ask the contract to read the proposal status from the DAO (`sync_dao_proposal`):
 * the contract cancels the payment only on the DAO's own answer. Anyone may call it; the executor does.
 */
export async function syncApprovals(): Promise<{ id: number; proposalId: number; status: string }[]> {
  const payments = await view<Payment[]>("list_payments", { from: 0, limit: 200 });
  const out: { id: number; proposalId: number; status: string }[] = [];
  for (const p of payments.filter((x) => x.status === "Approval" && x.dao_proposal_id !== null)) {
    try {
      const r = await call(config.executorAccount, "sync_dao_proposal", { id: p.id }, 60);
      const status = String(getTransactionLastResult(r as any) ?? "unknown");
      out.push({ id: p.id, proposalId: p.dao_proposal_id!, status });
      if (status !== "InProgress") console.log(`[executor] #${p.id} dao proposal ${p.dao_proposal_id}: ${status}`);
    } catch (e) {
      console.error(`[executor] #${p.id} sync failed:`, (e as Error).message);
    }
  }
  return out;
}

export async function runExecutor(opts: { once?: boolean } = {}) {
  const tick = async () => {
    await syncApprovals();
    if (config.network !== "mainnet") return; // Intents has no testnet
    await settleQueued();
    await confirmSettling();
  };
  await tick();
  if (opts.once) return;
  setInterval(tick, 20_000);
  console.log("[executor] running");
}
