// Thin NEAR helpers on near-api-js 7: view calls, signed calls, and NEP-366 meta transactions for the agent.
import { Account, JsonRpcProvider, KeyPairSigner, actions, encodeSignedDelegate, getTransactionLastResult } from "near-api-js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

export type Payout = { Near: { account: string } } | { Chain: { chain: string; address: string } };

export interface InvoiceClaim {
  vendor_id: string;
  invoice_number: string;
  amount: string;
  due_date: string;
  invoice_hash: string;
  payout_seen: Payout;
  attestation_ref: string;
  flags: string[];
}

export interface Payment {
  id: number;
  vendor_id: string;
  invoice_number: string;
  amount: string;
  status: string;
  reason: string | null;
  invoice_hash: string;
  attestation_ref: string;
  flags: string[];
  created_at: string;
  updated_at: string;
  quote_id: string | null;
  deposit_address: string | null;
  dest_tx: string | null;
  dao_proposal_id: number | null;
}

export interface Vendor {
  name: string;
  payout: Payout;
  monthly_budget: string;
  spent_this_month: string;
  month: number;
  active: boolean;
}

export const provider = new JsonRpcProvider({ url: config.rpc });

/**
 * Keys come from the standard NEAR credentials folder (~/.near-credentials/<network>/<account>.json,
 * written by near-cli) or from env `NEAR_KEY_<ACCOUNT>` with dots replaced by underscores.
 */
export async function signerFor(accountId: string): Promise<KeyPairSigner> {
  const envKey = process.env[`NEAR_KEY_${accountId.replace(/[.-]/g, "_").toUpperCase()}`];
  if (envKey) return KeyPairSigner.fromSecretKey(envKey as any);
  const file = join(config.keystore, config.network, `${accountId}.json`);
  const j = JSON.parse(await readFile(file, "utf8"));
  return KeyPairSigner.fromSecretKey(j.private_key ?? j.secret_key);
}

export async function account(id: string): Promise<Account> {
  return new Account(id, provider, await signerFor(id));
}

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId: config.treasury, method, args })) as T;
}

export async function call(signer: string, method: string, args: Record<string, unknown>, gasTgas = 100, depositYocto: bigint = 0n) {
  const a = await account(signer);
  return a.callFunctionRaw({
    contractId: config.treasury,
    methodName: method,
    args,
    gas: BigInt(gasTgas) * 1_000_000_000_000n,
    deposit: depositYocto,
  });
}

export function txHash(outcome: any): string {
  return outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? "";
}

/**
 * The agent signs a delegate action with its function-call key and hands it to the relayer,
 * so the agent account never needs NEAR for gas (NEP-366).
 */
export async function requestPaymentViaRelayer(claim: InvoiceClaim): Promise<{ txHash: string; paymentId: number }> {
  const a = await account(config.agentAccount);
  const { signedDelegate } = await a.createSignedMetaTransaction({
    receiverId: config.treasury,
    actions: [actions.functionCall("request_payment", { claim }, 150_000_000_000_000n, 0n)],
    blockHeightTtl: 120,
  });
  const bytes = encodeSignedDelegate(signedDelegate);
  const res = await fetch(`${config.relayerUrl}/relay`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from(bytes),
  });
  if (!res.ok) throw new Error(`relayer ${res.status}: ${await res.text()}`);
  return (await res.json()) as { txHash: string; paymentId: number };
}

/** Direct call, for when the agent account holds a little NEAR itself (no relayer). */
export async function requestPaymentDirect(claim: InvoiceClaim): Promise<{ txHash: string; paymentId: number }> {
  const r = await call(config.agentAccount, "request_payment", { claim }, 150);
  const paymentId = Number(getTransactionLastResult(r as any));
  return { txHash: txHash(r), paymentId };
}

export function fmtUsdc(units: string | number | bigint): string {
  const n = BigInt(units);
  const d = BigInt(10) ** BigInt(config.usdcDecimals);
  const whole = n / d;
  const frac = (n % d).toString().padStart(config.usdcDecimals, "0").slice(0, 2);
  return `${whole}.${frac} USDC`;
}

export function toUnits(amount: string | number): string {
  const [w, f = ""] = String(amount).replace(/,/g, "").split(".");
  const frac = (f + "0".repeat(config.usdcDecimals)).slice(0, config.usdcDecimals);
  return (BigInt(w || "0") * BigInt(10) ** BigInt(config.usdcDecimals) + BigInt(frac)).toString();
}
