// One-shot environment setup: accounts, contracts, keys, vendors, DAO, test funds.
//   bursar setup --root you.testnet            (testnet, deploys a throwaway tUSDC)
//   bursar setup --root you.near --mainnet     (mainnet, uses real USDC, no faucet)
// Needs the root account's full-access key in ~/.near-credentials/<network>/<root>.json (near-cli login).
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.js";

const NEAR = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
const TGAS = (n: number) => BigInt(n) * 10n ** 12n;
const USDC_MAINNET = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const SPUTNIK_FACTORY = { testnet: "sputnik-v2.testnet", mainnet: "sputnik-dao.near" };

// The DAO's policy: the council votes, anyone (the treasury contract included) may add a proposal, and a proposal
// costs a 0.1 NEAR bond instead of Sputnik's default 1 NEAR: the treasury pays one bond per held invoice and gets it
// back when the council decides, so the default would lock a NEAR per open hold.
const DAO_BOND = "100000000000000000000000"; // 0.1 NEAR
const daoPolicy = (council: string[]) => ({
  roles: [
    { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    { name: "council", kind: { Group: council }, permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: DAO_BOND,
  proposal_period: "604800000000000", // 7 days
  bounty_bond: DAO_BOND,
  bounty_forgiveness_period: "86400000000000",
});

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
  const wasmDir = resolve(process.cwd(), "..", "contracts");
  // The contracts must be built first: say so before any account is created, not after six of them are
  for (const [dir, file] of [["policy", "bursar_policy.wasm"], ["test-usdc", "test_usdc.wasm"]]) {
    const wasm = join(wasmDir, dir, "target", "wasm32-unknown-unknown", "release", file);
    await readFile(wasm).catch(() => { throw new Error(`${file} not found: build it first with (cd contracts/${dir} && cargo build --release --target wasm32-unknown-unknown)`); });
  }
  const sub = (name: string) => `${name}.${o.root}`;
  const names = {
    treasury: sub(`${o.prefix}treasury`),
    agent: sub(`${o.prefix}agent`),
    executor: sub(`${o.prefix}executor`),
    usdc: o.usdc ?? (o.network === "mainnet" ? USDC_MAINNET : sub(`${o.prefix}tusdc`)),
    vendorHosting: sub(`${o.prefix}acmehosting`),
    vendorLegal: sub(`${o.prefix}legalpartners`),
    vendorConsultant: sub(`${o.prefix}consultant`),
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

  // 1. accounts (the treasury is created together with its contract in step 4, and never gets an access key)
  const agent = await create(names.agent, 0.5); // enough gas for a few direct calls from the web console; the relayer path needs none
  const executor = await create(names.executor, 1);
  const vendorHosting = await create(names.vendorHosting, 0.1);
  const vendorLegal = await create(names.vendorLegal, 0.1);
  await create(names.vendorConsultant, 0.1); // a freelancer: the accountant sets a 20% withholding on this vendor

  // 2. test USDC on testnet
  if (o.network === "testnet" && !o.usdc) {
    const usdc = await create(names.usdc, 3.5);
    const code = await readFile(join(wasmDir, "test-usdc", "target", "wasm32-unknown-unknown", "release", "test_usdc.wasm"));
    const state = await usdc.getState();
    if (state.codeHash === "11111111111111111111111111111111") {
      await usdc.signAndSendTransaction({ receiverId: names.usdc, actions: [actions.deployContract(code), actions.functionCall("new", {}, TGAS(30), 0n)] });
      log(`deployed tUSDC at ${names.usdc}`);
    }
    for (const [to, amount] of [[names.treasury, "0"], [names.vendorHosting, "0"], [names.vendorLegal, "0"], [names.vendorConsultant, "0"], [o.root, "100000000000"]] as const) {
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
      const args = Buffer.from(JSON.stringify({ config: { name: daoName, purpose: "Bursar approvals", metadata: "" }, policy: daoPolicy([o.root]) })).toString("base64");
      await root.callFunction({ contractId: factory, methodName: "create", args: { name: daoName, args }, gas: TGAS(150), deposit: NEAR(6) });
      log(`created DAO ${names.dao} (council: ${o.root}, proposal bond 0.1 NEAR)`);
    } else log(`DAO ${names.dao} exists`);
  }

  // 4. policy contract. The account is created, funded and given its contract in one transaction signed by the root,
  // with no access key at all: from then on only the contract's owner methods (`upgrade` included) can change it.
  // Nobody holds a key that could redeploy or drain it, not even the company's own machine.
  {
    const code = await readFile(join(wasmDir, "policy", "target", "wasm32-unknown-unknown", "release", "bursar_policy.wasm"));
    const init = {
      owner: o.root,
      agent: names.agent,
      executor: names.executor,
      dao: o.dao ? names.dao : null,
      usdc: names.usdc,
      per_payment_cap: "10000000000",     // 10,000 USDC
      daily_cap: "20000000000",           // 20,000 USDC
      approval_threshold: "2000000000",   // 2,000 USDC
    };
    const near = o.dao ? 8 : 6; // ~4.7 NEAR of contract storage + DAO bonds
    if (!(await exists(names.treasury))) {
      await root.signAndSendTransaction({
        receiverId: names.treasury,
        actions: [actions.createAccount(), actions.transfer(NEAR(near)), actions.deployContract(code), actions.functionCall("new", init, TGAS(50), 0n)],
      });
      log(`created ${names.treasury} with ${near} NEAR and the policy contract in one transaction; the account has no access key`);
    } else {
      const acc = new Account(names.treasury, provider);
      const keyFile = join(config.keystore, o.network, `${names.treasury}.json`);
      const state = await provider.viewAccount({ accountId: names.treasury });
      if (state.code_hash === "11111111111111111111111111111111") {
        // an account made by an older setup, still without its contract: its full-access key deploys it
        if (!existsSync(keyFile)) throw new Error(`${names.treasury} exists without a contract and ${keyFile} is missing: delete the account or restore the key`);
        const t = new Account(names.treasury, provider, await loadSigner(o.network, names.treasury));
        await t.signAndSendTransaction({ receiverId: names.treasury, actions: [actions.deployContract(code), actions.functionCall("new", init, TGAS(50), 0n)] });
        log(`deployed policy contract at ${names.treasury}`);
      } else log(`policy contract already deployed at ${names.treasury}`);
      // keys left on the treasury by an older setup are dropped: the contract alone governs the account
      const keys = await acc.getAccessKeyList();
      if (keys.keys.length) {
        if (!existsSync(keyFile)) log(`WARNING: ${names.treasury} still has ${keys.keys.length} access key(s) and the key file is missing; delete them with the key that holds them`);
        else {
          const t = new Account(names.treasury, provider, await loadSigner(o.network, names.treasury));
          for (const k of keys.keys) await t.deleteKey(k.public_key);
          await rm(keyFile, { force: true });
          log(`removed ${keys.keys.length} access key(s) from ${names.treasury}: the account is governed by its contract only`);
        }
      }
    }
  }

  // 5. vendors
  const vendors = await provider.callFunction({ contractId: names.treasury, method: "list_vendors", args: {} }) as [string, unknown][];
  if (!vendors.some(([id]) => id === "acmehosting")) {
    await root.callFunction({ contractId: names.treasury, methodName: "add_vendor", args: { vendor_id: "acmehosting", name: "Acme Hosting", payout: { Near: { account: names.vendorHosting } }, monthly_budget: "3000000000", tax_id: "PT509876543" }, gas: TGAS(30) });
    await root.callFunction({ contractId: names.treasury, methodName: "add_vendor", args: { vendor_id: "legalpartners", name: "Legal Partners LLP", payout: { Near: { account: names.vendorLegal } }, monthly_budget: "0", tax_id: "IT09876543210" }, gas: TGAS(30) });
    await root.callFunction({ contractId: names.treasury, methodName: "add_vendor", args: { vendor_id: "designco", name: "DesignCo", payout: { Chain: { chain: "base", address: process.env.DEMO_BASE_ADDRESS ?? "0x4f1ac0de9b2b3c4d5e6f708192a3b4c5d6e7f801" } }, monthly_budget: "0", tax_id: "NL862345678B01" }, gas: TGAS(30) });
    await root.callFunction({ contractId: names.treasury, methodName: "add_vendor", args: { vendor_id: "consultant", name: "Studio Bianchi Consulting", payout: { Near: { account: names.vendorConsultant } }, monthly_budget: "0", tax_id: "IT05555555555", country: "IT", withholding_bps: 2000 }, gas: TGAS(30) });
    log("added vendors acmehosting (NEAR), legalpartners (NEAR), designco (Base), consultant (NEAR, 20% withholding set by the accountant), each with the tax id it prints on invoices");
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
      // the old full key is kept as <agent>.full.json until the chain has dropped it: a failure in between loses nothing
      const file = join(config.keystore, o.network, `${names.agent}.json`);
      const backup = file.replace(/\.json$/, ".full.json");
      if (full && existsSync(file)) await rename(file, backup);
      await saveKey(o.network, names.agent, fc);
      if (full) {
        // deleting a key needs a full-access key: `agent` still signs with the old one
        await agent.deleteKey(full.public_key);
        await rm(backup, { force: true });
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
    execFileSync("python3", [resolve(process.cwd(), "..", "invoices", "make_invoices.py"), "--near-vendor", names.vendorHosting, "--near-vendor-legal", names.vendorLegal, "--near-vendor-consultant", names.vendorConsultant], { stdio: "inherit" });
  } catch { log("could not regenerate invoices (python3 + reportlab needed); the samples folder still works if you pass the same vendor names"); }

  console.log("\nDone. Next:\n  set -a; source .env." + o.network + "; set +a\n  npm run relayer &\n  npm run agent -- --once --offline   # or without --offline with NEAR_AI_API_KEY set\n  npm run dev status\n");
}
