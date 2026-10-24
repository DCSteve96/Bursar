// Remove every access key from a treasury account: from then on only its contract (owner methods, `upgrade` included) can change it.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js"; import { readFile, rename } from "node:fs/promises";
const [account] = process.argv.slice(2);
const file = `/root/.near-credentials/testnet/${account}.json`;
const k = JSON.parse(await readFile(file, "utf8"));
const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }); const a = new Account(account, p, new KeyPairSigner(KeyPair.fromString(k.private_key)));
const roles = await p.callFunction({ contractId: account, method: "get_roles", args: {} });
const keys = await a.getAccessKeyList();
console.log(`${account}: owner ${(roles as any)[0]}, ${keys.keys.length} key(s) before`);
for (const key of keys.keys) { const r = await a.deleteKey(key.public_key); console.log(`deleted ${key.public_key} tx ${(r as any).transaction.hash}`); }
await rename(file, file.replace(/\.json$/, ".deleted.json"));
console.log(`${(await new Account(account, p).getAccessKeyList()).keys.length} key(s) after; key file renamed to .deleted.json`);
