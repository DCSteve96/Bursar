# Bursar

**An AI treasurer that pays invoices within limits it cannot change.**

The AI reads. The contract decides. A dumb executor moves the money.

Built for NEAR HACKATHON (November 1 to 14, 2026). Tracks: `realworld`, `business`, `privacy`, `security`.

## The problem

Every company pays invoices. The two things that go wrong are boring and expensive: someone pays a fake invoice (the "please note our new bank details" fraud, the most common business scam in the world), and someone pays the same invoice twice. Letting an AI do the work makes both worse, unless the AI never holds the keys.

## What Bursar does

1. An invoice PDF lands in the inbox.
2. The **agent** reads it inside a TEE on NEAR AI Cloud. The invoice never leaves the enclave in clear text; the model's answer comes with an attestation and a signed receipt.
3. The agent asks the **policy contract** on NEAR to pay. It signs with one function-call key that can only call `request_payment`, and sends it as a meta transaction, so the agent owns no NEAR at all.
4. The **contract** decides, deterministically and on chain:
   - vendor must be in the owner's allowlist
   - the payout printed on the invoice must equal the payout the owner recorded (otherwise `payout_changed`)
   - no duplicate invoice numbers per vendor
   - per-payment cap, per-vendor monthly budget, daily cap
   - at or above the approval threshold: a Sputnik DAO proposal is opened, a human approves it in Trezu; the proposal id is written back on the payment, and a rejected or expired proposal cancels it
5. Payment:
   - vendor on NEAR: USDC is transferred in the same transaction (`Paid`)
   - vendor on Base, Arbitrum, Solana or Sui: the **executor** (a plain process with the company's key, no AI) gets a NEAR Intents quote with the vendor's recorded address as recipient and calls `settle`. The contract releases USDC only if the recipient it reports equals the vendor record (`Settling`, then `Settled`).
   - a USDC transfer that fails on the token contract is rolled back in the callback: balance restored, payment marked `transfer_failed`, nothing lost
6. Everything is an on-chain event. The MCP server lets any assistant drive it, with exactly the agent's powers.
7. Anyone can re-verify the TEE receipt behind a payment, without the API key and without trusting the agent (`bursar verify`).

The AI never chooses an address. The executor cannot redirect funds. The owner is the only one who can change a payout, and a changed payout on an invoice is a block, not a payment.

## Live on testnet

| | |
|---|---|
| Policy contract | `treasury.bursar-itlecew5.testnet` |
| Agent (one function-call key) | `agent.bursar-itlecew5.testnet` |
| Executor / relayer | `executor.bursar-itlecew5.testnet` |
| DAO (Sputnik v2) | `bursar-bursar-itlecew5.sputnik-v2.testnet` |
| Test USDC | `tusdc.bursar-itlecew5.testnet` |

Payments 1 to 7 on that contract are the walkthrough below, run end to end on 20 October 2026: paid, queued, approved by the DAO and paid, blocked for a changed payout, blocked as duplicate, rejected by the DAO and cancelled, and a transfer to an unregistered account rolled back. Open `web/index.html?network=testnet&treasury=treasury.bursar-itlecew5.testnet` to see them.

Mainnet deployment with real USDC and NEAR Intents: see the demo post (link added at submission).

## Try it: do X, see Y

Prerequisites: Node 22+, Rust stable with the `wasm32-unknown-unknown` target, `poppler-utils` (`pdftoppm`, `pdftotext`), Python 3 with `reportlab` (only to regenerate the sample invoices).

```bash
git clone <repo> && cd bursar
(cd contracts/policy && cargo test && ./build.sh)
(cd contracts/test-usdc && cargo build --release --target wasm32-unknown-unknown)
cd app && npm install && npm test
```
See: `11 passed` from `cargo test`, `bursar_policy.wasm: 303102 bytes` (249 KB if `wasm-opt` is installed), and 7 passing app tests (signature recovery, receipt tampering, offline parser on the four samples).

**1. Create a testnet account** (any wallet, or `near account create-account sponsor-by-faucet-service you.testnet ...`) and put its full-access key in `~/.near-credentials/testnet/you.testnet.json`. You need about 20 NEAR: the faucet gives 10 per account, so create two and transfer from one to the other. RPC defaults to FastNEAR (`rpc.testnet.near.org` answers 429 these days); set `NEAR_RPC` to use another node.

**2. Deploy everything with one command.**

```bash
npx tsx src/cli.ts setup --root you.testnet
```
See: sub-accounts for treasury, agent, executor and two vendors; a throwaway tUSDC token; a Sputnik DAO with you as council; the policy contract deployed and funded with 15,000 tUSDC; the agent left with a single function-call key; `.env.testnet` written; sample invoices regenerated with your vendor accounts.

**3. Start the relayer and process the inbox.**

```bash
set -a; source .env.testnet; set +a
npm run relayer &
mkdir -p ../invoices/inbox && cp ../invoices/samples/*.pdf ../invoices/inbox/
npm run agent -- --once --offline      # drop --offline to read with NEAR AI Cloud (needs NEAR_AI_API_KEY)
npm run dev status
```
See, in `status` (the account names are yours; the same four decisions are live on the contract above):

```
#1 acmehosting   AH-0923   480.00 USDC  Paid                      <- NEAR vendor, under caps: paid in the same tx
#2 designco      DC-1107  1250.00 USDC  Queued                    <- Base vendor: waits for the executor (Intents, mainnet)
#3 legalpartners LP-2210  9800.00 USDC  Approval dao#0            <- above 2,000: DAO proposal 0 opened by the contract
#4 acmehosting   AH-0924   480.00 USDC  Blocked payout_changed    <- "please note our new wallet": refused
```
and in the relayer log, the agent's meta transactions paid by the executor account.

**4. Approve the big one as the DAO council.**

```bash
near contract call-function as-transaction bursar-you.sputnik-v2.testnet act_proposal json-args '{"id":0,"action":"VoteApprove"}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send
npm run dev status
```
See: `#3 ... Paid`, and the vendor's tUSDC balance up by 9,800. On mainnet the same proposal shows up in Trezu and is approved with one click.

If the council votes `VoteReject` instead, Sputnik does not call anyone back. Run `npm run dev sync`: the contract asks the DAO for the proposal status and, only on the DAO's own answer, cancels the payment and releases its budget. See: `#6 dao#1: Rejected` and `#6 ... Cancelled dao_rejected` in `status` (payment 6 on the live contract is exactly that). The executor runs this check on every tick.

A vendor whose NEAR account is not registered on the token contract makes `ft_transfer` fail. The contract's callback puts the money back: `Blocked transfer_failed`, balance unchanged (payment 7 on the live contract).

**5. Send a duplicate.**

```bash
cp ../invoices/samples/01-acme-hosting-0923.pdf ../invoices/inbox/again.pdf && npm run agent -- --once --offline
```
See: `Blocked duplicate_invoice`.

**6. Verify the TEE receipt yourself.** With `NEAR_AI_API_KEY` set, step 3 reads the invoices inside the enclave and writes one receipt per payment in `app/.bursar/receipts/<id>.json`: the exact request and response bytes, the gateway's ECDSA signature, the attestation report with the Intel TDX quote, and the nonce the agent chose. Anyone with that file can check it, without the API key:

```bash
npm run dev verify 1
```
See, one line per check:

```
 ok   bytes                request and response hashes match the stored bytes
 ok   signed_text          signed text is z-ai/glm-5.3-flash:...
 ok   signature            ECDSA signature recovers to 0x...
 ok   signer_kind          signed inside the model TEE (provider_tee)
 ok   attestation_signer   attestation report lists signer 0x...
 ok   attestation_nonce    report echoes our fresh nonce
 ok   quote_report_data    TDX quote report_data binds signer and nonce (mrtd ...)
 ok   quote_tcb            quote verified against Intel collateral: TCB UpToDate
 ok   extraction           the claim was built from exactly this model output
 ok   attestation_ref      claim carries nearai:...
 ok   on_chain             payment #1 on treasury.you.testnet carries this reference
verified: the decision was made on this model output, inside an attested TEE
```
Change one byte of the response in the receipt and run it again: `FAIL signed_text`, `FAIL extraction`. Receipts written with `--offline` have no AI receipt and fail at the first line, as they should.

**7. Drive it from an assistant (MCP).** Add to Claude Desktop, Claude Code or Codex:

```json
{ "mcpServers": { "bursar": { "command": "npx", "args": ["tsx", "src/cli.ts", "mcp"], "cwd": "<repo>/app", "env": { "NEAR_NETWORK": "testnet", "BURSAR_TREASURY": "treasury.you.testnet", "BURSAR_AGENT": "agent.you.testnet", "BURSAR_EXECUTOR": "executor.you.testnet", "BURSAR_USDC": "tusdc.you.testnet" } } } }
```
Then ask: "submit the invoice at invoices/samples/04-acme-hosting-0924-fraud.pdf and explain the decision". See: the tool `submit_invoice` returns `Blocked payout_changed`, and `explain_decision` says why in plain words. `verify_attestation` runs the checks of step 6; `sync_dao_approvals` the DAO check of step 4.

**8. Dashboard.** Open `web/index.html` in a browser (a static file, no build) and paste the treasury account. See: balance, caps, vendors with their monthly budget, and every payment with its decision, DAO proposal, destination transaction and attestation reference, all read from the RPC. Hostable on GitHub Pages as is.

**9. Cross-chain payout (mainnet only).** NEAR Intents has no testnet. With `NEAR_NETWORK=mainnet`, real USDC in the treasury and a vendor on Base, `npm run executor -- --once` quotes USDC NEAR to USDC Base with the vendor's address as recipient, calls `settle`, and marks the payment `Settled` with the Base transaction hash.

**Unit tests:** `cd contracts/policy && cargo test` (11 tests: pays under threshold, queues cross-chain, blocks changed payout, blocks duplicates and caps, DAO approval flow, proposal id recorded by callback, failed proposal releases budget, DAO rejection cancels, failed transfer restores balance, executor cannot redirect funds, only the agent can request). `cd app && npm test` (receipt verification against tampering, offline parser).

## NEAR features used, and why

| Feature | Where | Why it matters here |
|---|---|---|
| Function-call access keys | `setup` step 7, `agent` | The agent's only key can call one method on one contract. Stolen key = nothing. |
| Meta transactions (NEP-366) | `relayer.ts`, `near.ts` | The agent owns no NEAR. The relayer only forwards `request_payment` from the agent. |
| Sub-accounts | `setup.ts` | Agent, executor and treasury are separate accounts under the company. |
| NEAR AI Cloud (TEE) | `ai.ts` | Invoices are sensitive. Inference runs in a TEE, with attestation and a signed receipt stored next to the payment. |
| NEAR Intents (1-Click) | `executor.ts` | Vendors get USDC on their chain. The contract pins the recipient to the vendor record. |
| Sputnik DAO v2 / Trezu | `policy` contract | Human approval above a threshold, opened by the contract itself as a FunctionCall proposal; the callback stores the proposal id, `sync_dao_proposal` reads the verdict back. |
| NEP-141, NEP-297 events | `policy` contract | USDC in, every decision out as an event, so dashboards need no database. |

## Repository

```
contracts/policy      Rust, the policy contract (near-sdk 5), with unit tests
contracts/test-usdc   Rust, throwaway NEP-141 for testnet
app/src/agent.ts      inbox watcher, PDF to PNG, NEAR AI call, claim submission
app/src/ai.ts         NEAR AI Cloud client: attestation preflight, structured extraction, signed receipt with exact bytes
app/src/verify.ts     independent receipt verification: signature, nonce, TDX quote binding, Intel collateral, chain
app/src/near.ts       near-api-js 7 helpers, meta transactions
app/src/relayer.ts    NEP-366 relayer, restricted to request_payment
app/src/executor.ts   NEAR Intents 1-Click routing for cross-chain vendors
app/src/mcp.ts        MCP server (submit_invoice, list_payments, explain_decision, vendors, treasury_status)
app/src/setup.ts      one-shot environment setup
app/test/             vitest: receipt tampering, offline parser
web/index.html        static dashboard, reads the contract over RPC
invoices/             make_invoices.py and four fictional sample invoices
```

## Honest limits

- Software, not a payment service. You run it on your own accounts with your own keys; nothing passes through us.
- The offline parser (`--offline`) only understands the sample invoices. Real invoices need NEAR AI Cloud.
- Intents cross-chain payouts are mainnet only; the testnet demo stops at `Queued` for the Base vendor.
- `bursar verify` checks the signature, the nonce, the quote's `report_data` binding and the quote against Intel collateral. It does not yet replay the RTMR3 event log against the quote (which images and compose file ran in the enclave) and does not check GPU evidence; the receipt keeps both, so it can be added without re-running anything.
- The verifier was tested against synthetic receipts and tampering; a receipt from the live NEAR AI Cloud gateway has not been through it yet.

## License

MIT
