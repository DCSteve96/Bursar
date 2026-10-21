// One-shot environment setup: accounts, contracts, keys, vendors, DAO, test funds.
//   bursar setup --root you.testnet            (testnet, deploys a throwaway tUSDC)
//   bursar setup --root you.near --mainnet     (mainnet, uses real USDC, no faucet)
// Needs the root account's full-access key in ~/.near-credentials/<network>/<root>.json (near-cli login).
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.js";

const NEAR = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
const TGAS = (n: number) => BigInt(n) * 10n ** 12n;
const USDC_MAINNET = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const SPUTNIK_FACTORY = { testnet: "sputnik-v2.testnet", mainnet: "sputnik-dao.near" };

interface Opts { root: string; network: "testnet" | "mainnet"; prefix: string; dao: boolean; usdc?: string }

async function saveKey(network: string, accountId: string, kp: KeyPair) {
  const dir = join(config.keystore, network);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${accountId}.json`);
  await writeFile(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2), { mode: 0o600 });
  return file;
}

async function loadSigner(network: string, accountId: string) {
  const file = join(config.keystore, network, `${accountId}.json`);
  const j = JSON.parse(await readFile(file, "utf8"));
  return KeyPairSigner.fromSecretKey(j.private_key ?? j.secret_key);
}

export async function setup(o: Opts) {
  const rpc = process.env.NEAR_RPC ?? (o.network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
  const provider = new JsonRpcProvider({ url: rpc });
  const root = new Account(o.root, provider, await loadSigner(o.network, o.root));
  const sub = (name: string) => `${name}.${o.root}`;
  const names = {
    treasury: sub(`${o.prefix}treasury`),
    agent: sub(`${o.prefix}agent`),
    executor: sub(`${o.prefix}executor`),
    usdc: o.usdc ?? (o.network === "mainnet" ? USDC_MAINNET : sub(`${o.prefix}tusdc`)),
    vendorHosting: sub(`${o.prefix}acmehosting`),
    vendorLegal: sub(`${o.prefix}legalpartners`),
    dao: "",
  };
  const log = (m: string) => console.log(`[setup] ${m}`);

  const exists = async (id: string) => {
    try { await provider.viewAccount({ accountId: id }); return true; } catch { return false; }
  };

  const create = async (id: string, near: number) => {
    if (await exists(id)) {
      const bal = BigInt((await provider.viewAccount({ accountId: id })).amount);
      if (bal < NEAR(near) * 9n / 10n) {
        await root.transfer({ receiverId: id, amount: NEAR(near) - bal });
        log(`${id} exists, topped up to ${near} NEAR`);
      } else log(`${id} exists`);
      return new Account(id, provider, await loadSigner(o.network, id));
    }
    const kp = KeyPair.fromRandom("ed25519");
    await root.createSubAccount({ accountOrPrefix: id, publicKey: kp.getPublicKey(), nearToTransfer: NEAR(near) });
    await saveKey(o.network, id, kp);
    log(`created ${id} with ${near} NEAR`);
    return new Account(id, provider, new KeyPairSigner(kp));
  };

  // 1. accounts
  const treasury = await create(names.treasury, o.dao ? 8 : 6); // ~4.7 NEAR of contract storage + DAO bonds
  const agent = await create(names.agent, 0.5); // enough gas for a few direct calls from the web console; the relayer path needs none
  const executor = await create(names.executor, 1);
  const vendorHosting = await create(names.vendorHosting, 0.1);
  const vendorLegal = await create(names.vendorLegal, 0.1);

  // 2. test USDC on testnet
  const wasmDir = resolve(process.cwd(), "..", "contracts");
  if (o.network === "testnet" && !o.usdc) {
    const usdc = await create(names.usdc, 3.5);
    const code = await readFile(join(wasmDir, "test-usdc", "target", "wasm32-unknown-unknown", "release", "test_usdc.wasm"));
    const state = await usdc.getState();
    if (state.codeHash === "11111111111111111111111111111111") {
      await usdc.signAndSendTransaction({ receiverId: names.usdc, actions: [actions.deployContract(code), actions.functionCall("new", {}, TGAS(30), 0n)] });
      log(`deployed tUSDC at ${names.usdc}`);
    }
    for (const [to, amount] of [[names.treasury, "0"], [names.vendorHosting, "0"], [names.vendorLegal, "0"], [o.root, "100000000000"]] as const) {
      await root.callFunction({ contractId: names.usdc, methodName: "mint", args: { to, amount }, gas: TGAS(30), deposit: NEAR(0.01) });
    }
    log(`minted 100,000 tUSDC to ${o.root} and registered treasury and vendors`);
  }

  // 3. DAO (Sputnik v2) with the root as council
  if (o.dao) {
    const factory = SPUTNIK_FACTORY[o.network];
    const daoName = `${o.prefix}bursar-${o.root.split(".")[0]}`.replace(/[^a-z0-9-]/g, "-").slice(0, 40);
    names.dao = `${daoName}.${factory}`;
    if (!(await exists(names.dao))) {
      const args = Buffer.from(JSON.stringify({ config: { name: daoName, purpose: "Bursar approvals", metadata: "" }, policy: [o.root] })).toString("base64");
      await root.callFunction({ contractId: factory, methodName: "create", args: { name: daoName, args }, gas: TGAS(150), deposit: NEAR(6) });
      log(`created DAO ${names.dao} (council: ${o.root})`);
    } else log(`DAO ${names.dao} exists`);
  }

  // 4. policy contract
  {
    const code = await readFile(join(wasmDir, "policy", "target", "wasm32-unknown-unknown", "release", "bursar_policy.wasm"));
    const state = await treasury.getState();
    if (state.codeHash === "11111111111111111111111111111111") {
      await treasury.signAndSendTransaction({
        receiverId: names.treasury,
        actions: [
          actions.deployContract(code),
          actions.functionCall("new", {
            owner: o.root,
            agent: names.agent,
            executor: names.executor,
            dao: o.dao ? names.dao : null,
            usdc: names.usdc,
            per_payment_cap: "10000000000",     // 10,000 USDC
            daily_cap: "20000000000",           // 20,000 USDC
            approval_threshold: "2000000000",   // 2,000 USDC
          }, TGAS(50), 0n),
        ],
      });
      log(`deployed policy contract at ${names.treasury}`);
    } else log(`policy contract already deployed at ${names.treasury}`);
  }

  // 5. vendors
  const vendors = await provider.callFunction({ contractId: names.treasury, method: "list_vendors", args: {} }) as [string, unknown][];
  if (!vendors.some(([id]) => id === "acmehosting")) {
    await root.callFunction({ contractId: names.treasury, methodName: "add_vendor", args: { vendor_id: "acmehosting", name: "Acme Hosting", payout: { Near: { account: names.vendorHosting } }, monthly_budget: "3000000000", tax_id: "PT509876543" }, gas: TGAS(30) });
    await root.callFunction({ contractId: names.treasury, methodName: "add_vendor", args: { vendor_id: "legalpartners", name: "Legal Partners LLP", payout: { Near: { account: names.vendorLegal } }, monthly_budget: "0", tax_id: "IT09876543210" }, gas: TGAS(30) });
    await root.callFunction({ contractId: names.treasury, methodName: "add_vendor", args: { vendor_id: "designco", name: "DesignCo", payout: { Chain: { chain: "base", address: process.env.DEMO_BASE_ADDRESS ?? "0x4f1ac0de9b2b3c4d5e6f708192a3b4c5d6e7f801" } }, monthly_budget: "0", tax_id: "NL862345678B01" }, gas: TGAS(30) });
    log("added vendors acmehosting (NEAR), legalpartners (NEAR), designco (Base), each with the tax id it prints on invoices");
  }
  // 5b. what the company agreed to buy: a standing order for hosting, purchase orders for the two projects
  const orders = await provider.callFunction({ contractId: names.treasury, method: "list_orders", args: {} }) as unknown[];
  if (orders.length === 0) {
    await root.callFunction({ contractId: names.treasury, methodName: "add_recurring_order", args: { vendor_id: "acmehosting", description: "Dedicated server EU-West, monthly", amount_per_period: "500000000", period_days: 30, expires_at: null }, gas: TGAS(30) });
    await root.callFunction({ contractId: names.treasury, methodName: "add_order", args: { vendor_id: "designco", reference: "PO-2026-118", description: "Landing page redesign", amount: "1250000000", expires_at: null }, gas: TGAS(30) });
    await root.callFunction({ contractId: names.treasury, methodName: "add_order", args: { vendor_id: "legalpartners", reference: "PO-2026-104", description: "Trademark filing and advisory", amount: "9800000000", expires_at: null }, gas: TGAS(30) });
    log("recorded orders: hosting 500 USDC/month, PO-2026-118 (designco, 1,250), PO-2026-104 (legalpartners, 9,800)");
  }

  // 6. fund the treasury: 15,000 USDC on testnet, or whatever FUND_USDC says
  const fund = process.env.FUND_USDC ?? (o.network === "testnet" ? "15000000000" : "0");
  if (fund !== "0") {
    await root.callFunction({ contractId: names.usdc, methodName: "ft_transfer_call", args: { receiver_id: names.treasury, amount: fund, msg: "" }, gas: TGAS(60), deposit: 1n });
    log(`funded treasury with ${Number(fund) / 1e6} USDC`);
  }

  // 6b. list the treasury in the public registry (explorer and sign-in page). Entries are hints: readers verify the owner on the contract.
  const registry = process.env.BURSAR_REGISTRY ?? (o.network === "testnet" ? "registry.bursar-b48563e6.testnet" : "");
  if (registry && await exists(registry)) {
    const entry = await provider.callFunction({ contractId: registry, method: "get", args: { treasury: names.treasury } }) as { owner: string } | null;
    if (entry?.owner !== o.root) {
      await root.callFunction({ contractId: registry, methodName: "register", args: { treasury: names.treasury, owner: o.root }, gas: TGAS(30), deposit: NEAR(0.01) });
      log(`listed ${names.treasury} in the registry ${registry}`);
    } else log(`already listed in the registry ${registry}`);
  }

  // 7. the agent's key: one function-call key limited to request_payment, then drop the full-access key
  {
    const keys = await agent.getAccessKeyList();
    const hasFc = keys.keys.some((k: any) => k.access_key.permission !== "FullAccess");
    if (!hasFc) {
      const fc = KeyPair.fromRandom("ed25519");
      // The allowance only caps gas paid from the agent's own balance (0.1 NEAR here); it is not spending power.
      // 1 NEAR lets the key also sign direct calls (web page, `--direct`) when the relayer is not running.
      await agent.addFunctionCallAccessKey({ publicKey: fc.getPublicKey(), contractId: names.treasury, methodNames: ["request_payment"], allowance: NEAR(1) });
      const full = keys.keys.find((k: any) => k.access_key.permission === "FullAccess");
      await saveKey(o.network, names.agent, fc);
      if (full) {
        const a2 = new Account(names.agent, provider, new KeyPairSigner(fc));
        // deleting a key needs a full-access key; do it with the old signer before swapping
        await agent.deleteKey(full.public_key);
        void a2;
      }
      log(`agent ${names.agent} now holds only a function-call key for ${names.treasury}.request_payment`);
    }
  }

  // 8. write env file
  const envFile = resolve(process.cwd(), `.env.${o.network}`);
  const env = [
    `NEAR_NETWORK=${o.network}`,
    `BURSAR_TREASURY=${names.treasury}`,
    `BURSAR_AGENT=${names.agent}`,
    `BURSAR_EXECUTOR=${names.executor}`,
    `BURSAR_RELAYER=${names.executor}`,
    `BURSAR_USDC=${names.usdc}`,
    `BURSAR_DAO=${names.dao}`,
    `BURSAR_OWNER=${o.root}`,
    `BURSAR_INBOX=${resolve(process.cwd(), "..", "invoices", "inbox")}`,
  ].join("\n") + "\n";
  await writeFile(envFile, env);
  log(`wrote ${envFile}`);

  // 9. regenerate the demo invoices with the real vendor accounts
  try {
    execFileSync("python3", [resolve(process.cwd(), "..", "invoices", "make_invoices.py"), "--near-vendor", names.vendorHosting, "--near-vendor-legal", names.vendorLegal], { stdio: "inherit" });
  } catch { log("could not regenerate invoices (python3 + reportlab needed); the samples folder still works if you pass the same vendor names"); }

  console.log("\nDone. Next:\n  set -a; source .env." + o.network + "; set +a\n  npm run relayer &\n  npm run agent -- --once --offline   # or without --offline with NEAR_AI_API_KEY set\n  npm run dev status\n");
}
