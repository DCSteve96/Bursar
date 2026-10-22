// A tiny NEP-366 relayer. It pays gas for the agent's meta transactions, and only for calls to
// `request_payment` on the treasury contract. Anything else is refused.
import { createServer } from "node:http";
import { SCHEMA } from "near-api-js";
import { deserialize } from "borsh";
import { account, txHash } from "./near.js";
import { config } from "./config.js";

const MAX_GAS = 150_000_000_000_000n;
const MAX_PER_HOUR = Number(process.env.RELAYER_MAX_PER_HOUR ?? 300);
const recent: number[] = [];

export async function runRelayer(port = Number(new URL(config.relayerUrl).port || 8787)) {
  const relayer = await account(config.relayerAccount || config.executorAccount);
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/relay") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      const signed: any = deserialize(SCHEMA.SignedDelegate as any, new Uint8Array(Buffer.concat(chunks)));
      const d = signed.delegateAction;
      const fc = d.actions?.[0]?.functionCall;
      const ok =
        d.senderId === config.agentAccount &&
        d.receiverId === config.treasury &&
        d.actions.length === 1 &&
        fc?.methodName === "request_payment" &&
        BigInt(fc.deposit ?? 0) === 0n &&
        BigInt(fc.gas ?? 0) <= MAX_GAS;
      if (!ok) {
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "relayer only forwards request_payment from the agent, with at most 150 TGas" }));
        return;
      }
      // a stolen agent key must not burn the relayer's NEAR on failing calls: a fixed number of relays per hour
      const now = Date.now();
      while (recent.length && recent[0] < now - 3_600_000) recent.shift();
      if (recent.length >= MAX_PER_HOUR) {
        res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: `relayer limit: ${MAX_PER_HOUR} calls per hour` }));
        return;
      }
      recent.push(now);
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
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ txHash: txHash(outcome), paymentId }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  server.listen(port, () => console.log(`[relayer] ${relayer.accountId} pays gas on :${port} for ${config.agentAccount} -> ${config.treasury}.request_payment`));
}
