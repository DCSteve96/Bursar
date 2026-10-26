// Lower an existing Sputnik DAO's proposal bond to 0.1 NEAR (ChangePolicy proposal, voted by a council of one),
// then tell the treasury (set_roles dao_bond). Usage: dao-bond.mts DAO TREASURY OWNER
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js"; import { readFile } from "node:fs/promises";
const [dao, treasury, owner] = process.argv.slice(2);
const k = JSON.parse(await readFile(`/root/.near-credentials/testnet/${owner}.json`, "utf8"));
const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }); const a = new Account(owner, p, new KeyPairSigner(KeyPair.fromString(k.private_key)));
const view = (c: string, m: string, args = {}) => p.callFunction({ contractId: c, method: m, args }) as Promise<any>;
const pol = await view(dao, "get_policy");
const council = pol.roles.find((r: any) => r.name === "council")?.kind?.Group ?? [owner];
const BOND = "100000000000000000000000";
const policy = { ...pol, proposal_bond: BOND, bounty_bond: BOND };
console.log(`${dao}: bond ${Number(pol.proposal_bond) / 1e24} NEAR, council ${council.join(", ")}, last proposal id ${await view(dao, "get_last_proposal_id")}`);
const r1 = await a.callFunctionRaw({ contractId: dao, methodName: "add_proposal", args: { proposal: { description: "Bursar: proposal bond 0.1 NEAR", kind: { ChangePolicy: { policy } } } }, gas: 100_000_000_000_000n, deposit: BigInt(pol.proposal_bond) });
const id = Number(JSON.parse(Buffer.from((r1 as any).status.SuccessValue, "base64").toString()));
const r2 = await a.callFunctionRaw({ contractId: dao, methodName: "act_proposal", args: { id, action: "VoteApprove" }, gas: 300_000_000_000_000n, deposit: 0n });
const after = await view(dao, "get_policy");
console.log(`proposal ${id} voted (tx ${(r2 as any).transaction.hash}): bond now ${Number(after.proposal_bond) / 1e24} NEAR`);
const r3 = await a.callFunctionRaw({ contractId: treasury, methodName: "set_roles", args: { agent: null, executor: null, dao: null, dao_bond: BOND }, gas: 30_000_000_000_000n, deposit: 0n });
console.log(`treasury dao_bond set (tx ${(r3 as any).transaction.hash}), roles ${JSON.stringify(await view(treasury, "get_roles"))}`);
