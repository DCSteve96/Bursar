// The bytes 1Click signs for a quote, rebuilt from its response so the contract can check the signature on chain.
// 1Click signs base58(sha256(json-stable-stringify({ ...request, ...quote, timestamp }))) with ed25519; the request
// and quote fields are the ones its SDK (`verifyQuoteSignature`) keeps. The contract hashes exactly this string.
export const ONE_CLICK_SIGNER = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

const REQUEST_FIELDS = ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"] as const;
const REQUEST_OPTIONAL = ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"] as const;
const QUOTE_FIELDS = ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut"] as const;
const QUOTE_OPTIONAL = ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"] as const;

/** json-stable-stringify: keys sorted, JSON.stringify for values, undefined dropped. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** The signed payload of a quote response, as a string; `null` when the response lacks what the signature covers. */
export function signedPayload(response: any): string | null {
  const r = response?.quoteRequest, q = response?.quote;
  if (!r || !q || typeof response.timestamp !== "string") return null;
  const req: Record<string, unknown> = {};
  for (const k of REQUEST_FIELDS) req[k] = r[k];
  for (const k of REQUEST_OPTIONAL) req[k] = r[k] ? r[k] : undefined;
  const quote: Record<string, unknown> = {};
  for (const k of QUOTE_FIELDS) quote[k] = q[k];
  if (!r.dry) for (const k of QUOTE_OPTIONAL) quote[k] = q[k] || undefined;
  return stableStringify({ ...req, ...quote, timestamp: response.timestamp });
}
