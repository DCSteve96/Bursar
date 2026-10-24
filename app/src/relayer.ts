// A tiny NEP-366 relayer. It pays gas for the agent's meta transactions, and only for calls to
// `request_payment` on the treasury contract, signed by a key that is on the agent's account. Anything else is refused
// before it costs the relayer anything: the delegate signature is checked here, not only on chain.
import { createServer } from "node:http";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { SCHEMA, encodeDelegateAction } from "near-api-js";
import { deserialize } from "borsh";
import { account, txHash, provider } from "./near.js";
import { config } from "./config.js";

const MAX_GAS = 150_000_000_000_000n;
const MAX_BODY = 64 * 1024;
const MAX_PER_HOUR = Number(process.env.RELAYER_MAX_PER_HOUR ?? 300);
const MAX_PER_IP_PER_HOUR = Number(process.env.RELAYER_MAX_PER_IP_PER_HOUR ?? 60);
const HOST = process.env.RELAYER_HOST ?? "127.0.0.1";
const recent: number[] = [];
const perIp = new Map<string, number[]>();
const seen = new Map<string, number>(); // sha256 of a signed delegate -> when it was relayed; the same bytes are never paid for twice
const keyCache = new Map<string, number>(); // "account pubkey" -> when the chain confirmed it

const bytes = (x: any): Uint8Array | null => (x instanceof Uint8Array ? x : Array.isArray(x) ? Uint8Array.from(x) : x?.data ? bytes(x.data) : null);
const b58 = (u8: Uint8Array) => { const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n = BigInt("0x" + Buffer.from(u8).toString("hex")); let out = ""; while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; } for (const b of u8) { if (b !== 0) break; out = "1" + out; } return out; };

/** The delegate's key must be an access key of the agent account (checked on chain once per 10 minutes). */
async function keyOnAccount(accountId: string, pubkey: string): Promise<boolean> {
  const k = `${accountId} ${pubkey}`;
  const at = keyCache.get(k);
  if (at && Date.now() - at < 600_000) return true;
  try {
    await provider.query({ request_type: "view_access_key", finality: "final", account_id: accountId, public_key: pubkey });
    keyCache.set(k, Date.now());
    return true;
  } catch {
    return false;
  }
}

export async function runRelayer(port = Number(new URL(config.relayerUrl).port || 8787)) {
  const relayer = await account(config.relayerAccount || config.executorAccount);
  const server = createServer(async (req, res) => {
    const answer = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method !== "POST" || req.url !== "/relay") {
      res.writeHead(404).end();
      return;
    }
    const ip = req.socket.remoteAddress ?? "unknown";
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) { answer(413, { error: `body over ${MAX_BODY} bytes` }); req.destroy(); return; }
      chunks.push(c as Buffer);
    }
    const body = Buffer.concat(chunks);
    try {
      const signed: any = deserialize(SCHEMA.SignedDelegate as any, new Uint8Array(body));
      const d = signed.delegateAction;
      const fc = d.actions?.[0]?.functionCall;
      const ok =
        d.senderId === config.agentAccount &&
        d.receiverId === config.treasury &&
        d.actions.length === 1 &&
        fc?.methodName === "request_payment" &&
        BigInt(fc.deposit ?? 0) === 0n &&
        BigInt(fc.gas ?? 0) <= MAX_GAS;
      if (!ok) return answer(403, { error: "relayer only forwards request_payment from the agent, with at most 150 TGas" });
      // the signature over the delegate action, by the key the action names, and that key on the agent's account
      const pub = bytes(d.publicKey?.ed25519Key ?? d.publicKey);
      const sig = bytes(signed.signature?.ed25519Signature ?? signed.signature);
      if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return answer(403, { error: "not an ed25519 delegate" });
      const msg = createHash("sha256").update(encodeDelegateAction(d)).digest();
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
      if (!edVerify(null, msg, key, sig)) return answer(403, { error: "the delegate signature does not verify" });
      const pubStr = `ed25519:${b58(pub)}`;
      if (!(await keyOnAccount(config.agentAccount, pubStr))) return answer(403, { error: "that key is not on the agent's account" });
      // not expired, and not seen before
      const height = Number(d.maxBlockHeight ?? 0);
      const current = Number((await provider.viewBlock({ finality: "final" })).header.height);
      if (height && height < current) return answer(403, { error: "the delegate has expired" });
      const digest = createHash("sha256").update(body).digest("hex");
      const now = Date.now();
      for (const [h, t] of seen) if (t < now - 3_600_000) seen.delete(h);
      if (seen.has(digest)) return answer(409, { error: "already relayed" });
      // a stolen agent key must not burn the relayer's NEAR on failing calls: fixed numbers of relays per hour, overall and per address
      while (recent.length && recent[0] < now - 3_600_000) recent.shift();
      if (recent.length >= MAX_PER_HOUR) return answer(429, { error: `relayer limit: ${MAX_PER_HOUR} calls per hour` });
      const mine = (perIp.get(ip) ?? []).filter((t) => t > now - 3_600_000);
      if (mine.length >= MAX_PER_IP_PER_HOUR) return answer(429, { error: `relayer limit: ${MAX_PER_IP_PER_HOUR} calls per hour from one address` });
      mine.push(now); perIp.set(ip, mine);
      recent.push(now);
      seen.set(digest, now);
      const outcome: any = await relayer.relayMetaTransaction(signed);
      // The payment id is the return value of the delegated call, i.e. the receipt executed by the treasury.
      let paymentId: number | null = null;
      for (const r of outcome.receipts_outcome ?? []) {
        if (r.outcome?.executor_id !== config.treasury) continue;
        const sv = r.outcome?.status?.SuccessValue;
        if (!sv) continue;
        const v = JSON.parse(Buffer.from(sv, "base64").toString() || "null");
        if (typeof v === "number") {
          paymentId = v;
          break;
        }
      }
      answer(200, { txHash: txHash(outcome), paymentId });
    } catch (e) {
      answer(500, { error: (e as Error).message });
    }
  });
  server.listen(port, HOST, () => console.log(`[relayer] ${relayer.accountId} pays gas on ${HOST}:${port} for ${config.agentAccount} -> ${config.treasury}.request_payment`));
}
