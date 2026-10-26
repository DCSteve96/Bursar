import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js"; import { readFile } from "node:fs/promises";
const [from, to, near] = process.argv.slice(2);
const k = JSON.parse(await readFile(`/root/.near-credentials/testnet/${from}.json`, "utf8"));
const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }); const a = new Account(from, p, new KeyPairSigner(KeyPair.fromString(k.private_key)));
const r = await a.transfer({ receiverId: to, amount: BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n });
console.log(`sent ${near} NEAR ${from} -> ${to} tx ${(r as any).transaction.hash}`);
