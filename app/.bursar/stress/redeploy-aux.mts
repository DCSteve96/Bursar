// Redeploy the registry (signed by the root, which holds its key) and the test USDC (its own key), then reindex the registry.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js"; import { readFile } from "node:fs/promises";
const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const signer = async (acc: string) => new KeyPairSigner(KeyPair.fromString(JSON.parse(await readFile(`/root/.near-credentials/testnet/${acc}.json`, "utf8")).private_key));
const registry = "registry.bursar-b48563e6.testnet", usdc = "tusdc.bursar-b48563e6.testnet", root = "bursar-b48563e6.testnet";
const reg = new Account(registry, p, await signer(root));
const before = await p.callFunction({ contractId: registry, method: "list", args: { from: 0, limit: 5 } }).catch((e) => String(e).slice(0, 100));
const r1 = await reg.signAndSendTransaction({ receiverId: registry, actions: [actions.deployContract(await readFile("/home/user/Bursar/contracts/registry/target/wasm32-unknown-unknown/release/bursar_registry.wasm"))] });
const r2 = await reg.callFunctionRaw({ contractId: registry, methodName: "reindex", args: { from: 0, limit: 100 }, gas: 100_000_000_000_000n, deposit: 0n });
const after = await p.callFunction({ contractId: registry, method: "list", args: { from: 0, limit: 5 } }).catch((e) => String(e).slice(0, 100));
console.log(`registry redeployed tx ${r1.transaction.hash}, reindex tx ${(r2 as any).transaction.hash}\n before ${JSON.stringify(before).slice(0, 300)}\n after  ${JSON.stringify(after).slice(0, 300)}`);
const u = new Account(usdc, p, await signer(usdc));
const meta = await p.callFunction({ contractId: usdc, method: "ft_metadata", args: {} });
const r3 = await u.signAndSendTransaction({ receiverId: usdc, actions: [actions.deployContract(await readFile("/home/user/Bursar/contracts/test-usdc/target/wasm32-unknown-unknown/release/test_usdc.wasm"))] });
const supply = await p.callFunction({ contractId: usdc, method: "ft_total_supply", args: {} });
console.log(`tusdc redeployed tx ${r3.transaction.hash}, symbol ${(meta as any).symbol}, supply ${supply}`);
