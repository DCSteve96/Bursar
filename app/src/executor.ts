// The executor: no AI, company key. For every Queued payment it asks NEAR Intents for a quote whose
// recipient is the vendor's payout recorded on chain, then calls `settle`. The contract re-checks the
// recipient before releasing USDC to the Intents deposit address. Intents 1-Click runs on mainnet only.
import { OpenAPI, OneClickService, QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { config, USDC_ASSET } from "./config.js";
import { call, view, txHash, type Payment, type Vendor } from "./near.js";
import { getTransactionLastResult } from "near-api-js";

OpenAPI.BASE = config.oneClickUrl;
if (config.oneClickJwt) OpenAPI.TOKEN = config.oneClickJwt;

async function quoteFor(p: Payment, v: Vendor) {
  if (!("Chain" in v.payout)) throw new Error("near vendors are paid directly by the contract");
  const { chain, address } = v.payout.Chain;
  const dest = USDC_ASSET[chain];
  if (!dest) throw new Error(`no USDC asset id for chain ${chain}`);
  return OneClickService.getQuote({
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_OUTPUT, // the vendor receives exactly the invoice amount
    slippageTolerance: 50,
    originAsset: USDC_ASSET.near,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    destinationAsset: dest,
    amount: p.amount,
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
    const v = await view<Vendor | null>("get_vendor", { vendor_id: p.vendor_id });
    if (!v) continue;
    try {
      const q = await quoteFor(p, v);
      const deposit = q.quote.depositAddress!;
      const amountIn = BigInt(q.quote.amountIn);
      if (amountIn > BigInt(p.amount) * 102n / 100n) throw new Error(`quote asks ${q.quote.amountIn} for ${p.amount}, fees too high`);
      console.log(`[executor] #${p.id} ${p.amount} -> ${(v.payout as any).Chain.chain}:${(v.payout as any).Chain.address} via ${deposit}`);
      const r = await call(config.executorAccount, "settle", {
        id: p.id,
        quote_id: q.correlationId,
        deposit_address: deposit,
        recipient: v.payout,
      }, 60);
      await OneClickService.submitDepositTx({ depositAddress: deposit, txHash: txHash(r) } as any).catch(() => {});
    } catch (e) {
      console.error(`[executor] #${p.id} quote failed:`, (e as Error).message);
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
        // Intents sent the USDC back with a plain transfer: the payment goes back to the queue, the owner syncs the balance
        await call(config.executorAccount, "mark_settlement_failed", { id: p.id }, 30);
        console.error(`[executor] #${p.id} ${s.status}: funds refunded to ${config.treasury}, payment back in the queue; the owner presses Sync balance, then retries or cancels`);
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
