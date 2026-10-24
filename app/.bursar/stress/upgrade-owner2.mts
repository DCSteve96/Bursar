import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js"; import { readFile } from "node:fs/promises";
const [treasury, owner] = process.argv.slice(2);
const k = JSON.parse(await readFile(`/root/.near-credentials/testnet/${owner}.json`, "utf8"));
const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }); const a = new Account(owner, p, new KeyPairSigner(KeyPair.fromString(k.private_key)));
const code = await readFile("/home/user/Bursar/web/contracts/bursar_policy.wasm");
try {
  const r = await a.callFunctionRaw({ contractId: treasury, methodName: "upgrade", args: { code: code.toString("base64") }, gas: 300_000_000_000_000n, deposit: 0n });
  console.log("ok", (r as any).transaction.hash);
} catch (e: any) {
  console.log("message:", String(e.message).slice(0, 600));
  const s = JSON.stringify(e, null, 0);
  const m = s.match(/"ExecutionError":"([^"]{0,400})/); console.log("exec:", m?.[1]);
  const g = s.match(/gas_burnt":(\d+)/g); console.log("gas burnt per outcome:", g?.slice(0, 6));
}
