// All configuration comes from the environment. Nothing here is secret; keys live in env vars or the NEAR keystore.
import { homedir } from "node:os";
import { join } from "node:path";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

export const config = {
  network: env("NEAR_NETWORK", "testnet") as "testnet" | "mainnet",
  // rpc.testnet.near.org rate-limits hard (429) since 2026; FastNEAR's free endpoints are the default. Override with NEAR_RPC.
  rpc: process.env.NEAR_RPC ?? (process.env.NEAR_NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com"),
  keystore: process.env.NEAR_KEYSTORE ?? join(homedir(), ".near-credentials"),

  // The policy contract (the company's treasury account).
  treasury: env("BURSAR_TREASURY", "treasury.bursar.testnet"),
  // Roles
  agentAccount: env("BURSAR_AGENT", "agent.bursar.testnet"),
  executorAccount: env("BURSAR_EXECUTOR", "executor.bursar.testnet"),
  relayerAccount: process.env.BURSAR_RELAYER ?? "",
  owner: process.env.BURSAR_OWNER ?? "",
  relayerUrl: process.env.BURSAR_RELAYER_URL ?? "http://127.0.0.1:8787",

  // USDC NEP-141 contract. Mainnet: native Circle USDC. Testnet: any FT you deploy or usdc.fakes.testnet.
  usdc: env("BURSAR_USDC", "usdc.fakes.testnet"),
  usdcDecimals: Number(process.env.BURSAR_USDC_DECIMALS ?? "6"),

  // NEAR AI Cloud (TEE inference)
  aiBaseUrl: process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1",
  aiApiKey: process.env.NEAR_AI_API_KEY ?? "",
  aiModel: process.env.NEAR_AI_MODEL ?? "Qwen/Qwen3-VL-30B-A3B-Instruct",

  // NEAR Intents 1-Click (mainnet only)
  oneClickUrl: process.env.ONE_CLICK_URL ?? "https://1click.chaindefuser.com",
  oneClickJwt: process.env.ONE_CLICK_JWT ?? "",

  inbox: process.env.BURSAR_INBOX ?? join(process.cwd(), "..", "invoices", "inbox"),
  // The reading relay that hosts the Telegram inbox, and this treasury's inbox token (Settings, Keys, in the console).
  // Both set: the agent also reads and submits the invoices approved from Telegram.
  relay: (process.env.BURSAR_RELAY ?? "").replace(/\/$/, ""),
  inboxToken: process.env.BURSAR_INBOX_TOKEN ?? "",
  explorer: process.env.NEAR_EXPLORER ?? (process.env.NEAR_NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io"),
  state: process.env.BURSAR_STATE ?? join(process.cwd(), ".bursar"),
};

// Intents asset ids for USDC, per chain name used in vendor payouts.
export const USDC_ASSET: Record<string, string> = {
  near: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  arb: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  sol: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  sui: "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near",
};
