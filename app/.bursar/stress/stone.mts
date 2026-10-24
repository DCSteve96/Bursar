// Rescue path for a key-less treasury whose build kept too little gas back in `upgrade`:
// 1. the owner calls `upgrade` with the tiny stone (small code, small fees: fits), 2. the owner calls the stone's `redeploy` with the real code.
// Usage: stone.mts TREASURY OWNER STONE_WASM
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js"; import { readFile } from "node:fs/promises"; import { createHash } from "node:crypto";
const [treasury, owner, stoneWasm] = process.argv.slice(2);
const k = JSON.parse(await readFile(`/root/.near-credentials/testnet/${owner}.json`, "utf8"));
const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }); const a = new Account(owner, p, new KeyPairSigner(KeyPair.fromString(k.private_key)));
const real = await readFile("/home/user/Bursar/web/contracts/bursar_policy.wasm"); const stone = await readFile(stoneWasm);
const b58 = (u8: Buffer) => { const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n = BigInt("0x" + u8.toString("hex")); let out = ""; while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; } return out; };
const realHash = b58(createHash("sha256").update(real).digest());
const stats = () => p.callFunction({ contractId: treasury, method: "get_stats", args: {} });
const code = async () => (await p.viewAccount({ accountId: treasury })).code_hash;
console.log(`${treasury}: code ${await code()}, keys ${(await new Account(treasury, p).getAccessKeyList()).keys.length}, stats ${JSON.stringify(await stats())}`);
const r1 = await a.callFunctionRaw({ contractId: treasury, methodName: "upgrade", args: { code: stone.toString("base64") }, gas: 300_000_000_000_000n, deposit: 0n });
console.log(`stone (${stone.length} bytes) in place: tx ${(r1 as any).transaction.hash}, code ${await code()}`);
const r2 = await a.callFunctionRaw({ contractId: treasury, methodName: "redeploy", args: { code: real.toString("base64") }, gas: 300_000_000_000_000n, deposit: 0n });
const now = await code();
console.log(`real code back: tx ${(r2 as any).transaction.hash}, code ${now} ${now === realHash ? "== web/contracts/bursar_policy.wasm" : "DIFFERENT from the wasm, check"}`);
console.log(`stats ${JSON.stringify(await stats())}, vendors ${(await p.callFunction({ contractId: treasury, method: "list_vendors", args: {} }) as any[]).length}, payments ${(await p.callFunction({ contractId: treasury, method: "list_payments", args: { from: 0, limit: 200 } }) as any[]).length}`);
