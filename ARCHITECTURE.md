# Bursar: architecture

Translated from the Italian draft of 20 October 2026 and brought up to date with the code on 7 November 2026. The README has the runnable steps; this page is the map.

Guiding sentence: **The AI reads. The contract decides. A dumb executor moves the money.** The AI never sees a key with spending power and never chooses a payment address.

Tracks: `realworld` (main), `business`, `privacy`, `security`.

## 1. The parts

```
inbox (PDF, Telegram, console)  ->  agent or browser (reading in NEAR AI Cloud's TEE)  ->  policy contract (NEAR, Rust)
                                                                                              |-> Paid        USDC on NEAR to the vendor, by the contract itself
                                                                                              |-> Queued      executor -> 1Click quote -> settle, verified by the contract -> USDC on Base, Arbitrum, Ethereum, Solana or Sui
                                                                                              |-> Approval    a person (owner, approver) or a Sputnik DAO council decides
                                                                                              |-> Blocked     unknown vendor, changed payout, duplicate, cap, budget, paused, ...
explorer, dashboard, console and MCP server read the contract and the registry
```

### 1.1 Policy contract (`contracts/policy`, Rust, near-sdk 5, 67 unit tests)

Deployed on the company's own account, created together with the contract in one transaction and never given an access key: only the contract's owner-gated methods can change it, `upgrade` included (the contract deploys the new wasm on itself and runs `migrate` in the same batch). The USDC (NEP-141) is deposited on the contract.

State:
- `owner`, `agent`, `executor`, optional `dao` (Sputnik), `usdc` (the token contract), `quote_signer` (1Click's ed25519 key by default).
- `limits`: `per_payment_cap`, `daily_cap`, `approval_threshold`; `require_orders` (strict order mode); `paused`.
- `company`: name, description, country, optional tax id.
- `vendors`: name, payout (`{Near: account}` or `{Chain: {chain, address}}`), monthly budget and spend, tax id, country, withholding rate, active flag, order-bound flag, whether the payout is confirmed by the owner.
- `orders`: purchase orders with a total and standing orders with a period, per vendor.
- `operators` with roles (approve, manage vendors, manage orders).
- `payments`: status (`Paid | Queued | Settling | Settled | Approval | Blocked | Cancelled`), amount, vendor, invoice number, file hash, attestation reference, flags, timestamps, DAO proposal id, order id, withheld amount, and for cross-chain payments the quote id, the deposit account and the destination transaction.
- Indexes against duplicates (normalized invoice number per vendor, file hash), daily counters (spend, quotas per caller, autopaid invoices per vendor), `withheld_due`, `in_flight`, the ownership offer, the vault blob.

Who may call what:
- Owner only: vendors' payout confirmation, limits, order policy, company record, operators, roles, DAO, pause, withholding counters, `withdraw` and `remit_withholding` (USDC to the owner), `set_quote_signer`, `upgrade`, `set_vault`, ownership offer.
- Owner or operator with the role: vendors (`add_vendor`, `update_vendor`; an operator's payout change pays nothing until the owner confirms), orders, approvals and cancellations, DAO proposals.
- `request_payment(claim)`: the agent, the owner or an operator. The claim carries vendor id, invoice number, amount, due date, file hash, the payout printed on the invoice, tax ids, withholding, order reference, flags, attestation reference. Checks: paused, vendor known and active, `payout_seen` equals the recorded payout (else `Blocked payout_changed`), payout confirmed, duplicate, zero amount, caps, budget, treasury balance; then holds: threshold, orders (for vendors with orders, or for all in strict mode), model flags, tax ids, withholding, daily autopay allowance. Under the threshold a NEAR vendor is paid in the same receipt (`Paid`), a vendor on another chain is `Queued`. A hold opens a Sputnik proposal when a DAO is set, or waits for the owner or an approver. Every caller but the owner is bound by daily quotas (requests, refusals, holds, proposals); refused payments are stored small.
- `settle(id, payload, signature)`: the executor only. The payload is the exact JSON 1Click signed; the contract verifies the signature against `quote_signer`, then that the quote is not dry, EXACT_INPUT, spends this treasury's USDC, delivers USDC on the vendor's chain, refunds to the treasury, pays the vendor's recorded address for exactly the net amount, keeps at least 98 percent, has not expired, and deposits to an implicit account; then it registers that account on the token and transfers the USDC, in one receipt. `mark_settled(id, dest_tx)` closes it; `mark_settlement_failed` returns a refunded payment to a person once the token shows the USDC back.
- Views: `get_payment`, `list_payments`, `get_vendor`, `list_vendors`, `get_limits`, `get_company`, `list_operators`, `list_orders`, `get_roles`, `get_stats`, `preview_payment` (the decision without recording it), `get_ownership_offer`, `get_quote_signer`, `get_vault`.

Every transition emits a NEP-297 event, so the pages and the MCP server read everything from the chain.

### 1.2 Reading (`app/src/ai.ts`, `web/console.html`)

The PDF is rendered to PNG pages (and its text layer extracted) and sent to a vision model in NEAR AI Cloud's Intel TDX enclave, after fetching the enclave's attestation for a fresh nonce. The answer is a JSON claim plus a receipt: the exact request and response bytes, the gateway's ECDSA signature over them, the attestation with the TDX quote. `verify.ts` and the console check the receipt independently: bytes, signed text, signature, signer kind, attestation signer and nonce, quote binding, Intel collateral (TCB), extraction, completion id, attestation reference, and the payment on chain. The model is `Qwen/Qwen3-VL-30B-A3B-Instruct` with `z-ai/glm-5.3-flash` as fallback. A company brings its own NEAR AI key; the demo's shared relay (`relay/worker.js`) forwards the bytes untouched with daily caps.

### 1.3 Agent (`app/src/agent.ts`)

Watches an inbox folder and the Telegram inbox (through the relay), reads each PDF, builds the claim and sends `request_payment` with its one function-call key, as a NEP-366 meta transaction through the relayer (`relayer.ts`, which forwards nothing else), so on that path it pays no gas. It does not know the vendor's payout: it only reports what the invoice shows, and the contract compares.

### 1.4 Executor (`app/src/executor.ts`, and the console's automatic settlement)

A plain process with the executor key (methods: `settle`, `mark_settled`, `mark_settlement_failed`, `sync_dao_proposal`). For each `Queued` payment it asks 1Click for an EXACT_INPUT quote on the net amount with the vendor's recorded address as recipient, calls `settle` with the signed bytes, follows the swap, and calls `mark_settled` with the destination hash. On testnet the console's `?intents=stub` plays 1Click with the contract's test signer.

### 1.5 Approvals

Without a DAO the owner or an operator with the approve role approves or cancels in the console (or from Telegram, where an approval marks the invoice for reading; the contract still decides). With a Sputnik DAO v2 the contract opens a FunctionCall proposal and the council votes in the console or in Trezu; `sync_dao_proposal` picks up rejections.

### 1.6 Keys

- Treasury account: no key at all.
- Agent: one function-call key, `request_payment` only.
- Executor: one function-call key, the four methods above.
- Owner signed in with a wallet: a browser key limited to ten everyday methods (orders, approvals and cancellations, DAO proposals and sync, balance sync, vault, request); vendors, payouts, limits, operators, the DAO, withdrawals, ownership and upgrades are signed by the wallet. The README says exactly what a stolen browser key can still do.
- Operators: invite keys limited to their role's methods.
- The company's secrets (agent and executor keys, inbox token) live in the browser that uses them and, encrypted, in a vault on the contract that only the owner's wallet can open; devices are admitted with a signed request.

### 1.7 Registry (`contracts/registry`, 7 unit tests)

A public list of treasuries (register for a fee, claim evicts a squatter after checking `get_roles`). Entries are hints: the explorer and the login page verify the owner and the code hash on each contract.

### 1.8 Pages (`web/`) and MCP (`app/src/mcp.ts`)

Static pages, no build: landing, login (wallets through NEAR Connect, invite links, keys files), explorer (the network), dashboard (one treasury), console (the back office: Overview, Invoices, Attention, Vendors, Orders, Analytics, Settings, Inbox), docs, privacy. The MCP server exposes ten tools (submit, list, get, explain, orders, vendors, status, verify a receipt, sync DAO approvals, cancel a held payment) so any assistant can drive a treasury.

## 2. The demo invoices

1. Acme Hosting, 480 USDC, vendor on NEAR, under the threshold: `Paid`.
2. DesignCo, 1,250 USDC, vendor on Base: `Queued`, then settled through NEAR Intents.
3. Legal Partners, 9,800 USDC, over the threshold: `Approval`, then paid after the vote.
4. Acme Hosting with "new wallet" details: `Blocked payout_changed`. The same invoice again: `Blocked duplicate_invoice`.
5. to 10. Invoices for the holds: no order, identity and buyer mismatch, withholding, a vendor deactivated, a second cross-chain invoice.

## 3. NEAR primitives used

- NEAR AI Cloud: inference in a TEE with attestation and signed receipts (privacy).
- Function-call access keys limited to one method, sub-accounts for the agent and the executor (security).
- Meta transactions, NEP-366: the agent pays no gas on the relayer path (realworld).
- `env::ed25519_verify` in the contract: 1Click's quote signature verified on chain before any cross-chain payment (security).
- NEAR Intents 1-Click: the vendor is paid on the chain it uses (realworld, business).
- Sputnik DAO v2 and Trezu: human approvals (business).
- NEP-297 events as the ledger every page reads.
- Access keys as identity: a device is admitted to the vault when its key is one of the owner account's own full-access keys.
