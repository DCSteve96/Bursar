<p align="center"><img src="web/brand/readme-hero.svg" width="100%" alt="Bursar: the AI reads, the contract decides, a dumb executor moves the money"></p>

<h1 align="center">Bursar</h1>

<p align="center"><strong>An AI treasurer that pays invoices within limits it cannot change.</strong><br>The AI reads. The contract decides. A dumb executor moves the money.</p>

<p align="center">
<a href="https://bursar.network/console">Console</a> &nbsp;·&nbsp;
<a href="https://bursar.network/explorer">Explorer</a> &nbsp;·&nbsp;
<a href="https://bursar.network/docs">Docs</a> &nbsp;·&nbsp;
<a href="WHITEPAPER.md">White paper</a> &nbsp;·&nbsp;
<a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
<img alt="policy contract: 67 unit tests" src="https://img.shields.io/badge/policy%20contract-67%20tests-00ec97?style=flat-square&labelColor=0d0f0e">
<img alt="three review rounds" src="https://img.shields.io/badge/security-3%20review%20rounds-00ec97?style=flat-square&labelColor=0d0f0e">
<img alt="live on NEAR testnet" src="https://img.shields.io/badge/NEAR-testnet%20live-00ec97?style=flat-square&labelColor=0d0f0e">
<img alt="reading in a TEE" src="https://img.shields.io/badge/reading-NEAR%20AI%20Cloud%20TEE-00ec97?style=flat-square&labelColor=0d0f0e">
<img alt="Rust, near-sdk 5" src="https://img.shields.io/badge/Rust-near--sdk%205-ffffff?style=flat-square&labelColor=0d0f0e">
<img alt="TypeScript, near-api-js 7" src="https://img.shields.io/badge/TypeScript-near--api--js%207-ffffff?style=flat-square&labelColor=0d0f0e">
<img alt="MIT license" src="https://img.shields.io/badge/license-MIT-ffffff?style=flat-square&labelColor=0d0f0e">
</p>

Built for NEAR HACKATHON (November 1 to 14, 2026). Tracks: `realworld`, `business`, `privacy`, `security`. Development started on October 20, 2026, the day after the hackathon was announced: the rules count code from the announcement on October 19 to November 14 (HACKATHON.md, Q-001), so every commit in this repository, from the first one, is inside the window. The commit history is kept as it is.

## The problem

Every company pays invoices. The two things that go wrong are boring and expensive: someone pays a fake invoice (the "please note our new bank details" fraud, the most common business scam in the world), and someone pays the same invoice twice. Letting an AI do the work makes both worse, unless the AI never holds the keys.

## What Bursar does

```mermaid
flowchart LR
    V["Vendor sends a PDF<br>file drop, Telegram, MCP"] --> A
    subgraph enclave["NEAR AI Cloud, TEE"]
        A["The model reads it<br>attestation before, signed receipt after"]
    end
    A -- "request_payment<br>one function-call key, gas paid by the relayer" --> C
    subgraph chain["NEAR, the company's own contract"]
        C{"The policy contract decides"}
        C -- "within the limits" --> P["Paid on NEAR<br>same transaction"]
        C -- "vendor on another chain" --> Q["Queued"]
        C -- "threshold, flags, no order" --> H["Held for a person<br>owner, approver or DAO council"]
        C -- "changed payout, duplicate, over cap" --> B["Blocked, with the reason"]
    end
    Q --> E["Executor, no AI<br>NEAR Intents, only to the registered payout"]
    style C fill:#0d0f0e,stroke:#00ec97,color:#fff
    style P fill:#0d0f0e,stroke:#00ec97,color:#00ec97
    style H fill:#0d0f0e,stroke:#ffc266,color:#ffc266
    style B fill:#0d0f0e,stroke:#ff6b6b,color:#ff6b6b
```

1. An invoice PDF lands in the inbox.
2. The **agent** has it read inside a TEE on NEAR AI Cloud. With the company's own NEAR AI key the invoice goes from its browser or agent straight to the enclave, over TLS, and no Bursar server sees it; the model's answer comes with an attestation and a signed receipt. (The shared "Bursar reading" relay of the hackathon demo forwards the bytes untouched, so the receipt still verifies, but they do pass through it: step 9.)
3. The agent asks the **policy contract** on NEAR to pay. It signs with one function-call key that can only call `request_payment`, and sends it as a meta transaction through a relayer, so on that path the agent pays no gas (the console and the MCP server can also call the contract directly, and `setup` leaves the agent 0.5 NEAR for that).
4. The **contract** decides, deterministically and on chain:
   - vendor must be in the owner's allowlist
   - the payout printed on the invoice must equal the payout the owner recorded (otherwise `payout_changed`)
   - no duplicate invoice numbers per vendor
   - per-payment cap, per-vendor monthly budget, daily cap
   - at or above the approval threshold: a Sputnik DAO proposal is opened, a human approves it in Trezu; the proposal id is written back on the payment, and a rejected or expired proposal cancels it. The DAO that `setup` and the console create asks a 0.1 NEAR bond per proposal (Sputnik's default is 1 NEAR); the treasury pays it and gets it back when the council decides, and when the account cannot cover a bond the invoice still waits, without a proposal, until someone opens it or tops the account up; a DAO created earlier with the 1 NEAR default is moved to 0.1 NEAR from the console (Settings, Governance: one proposal, voted with the owner's seat)
5. Payment:
   - vendor on NEAR: USDC is transferred in the same transaction (`Paid`)
   - vendor on Base, Arbitrum, Ethereum, Solana or Sui: the **executor** (a plain process with the company's key, no AI) gets a NEAR Intents quote (EXACT_INPUT on the net amount the contract will send) with the vendor's recorded address as recipient and calls `settle` with the bytes 1Click signed and its signature. The contract verifies the signature against 1Click's key, checks that the quote pays the vendor's recorded address for exactly the net amount in USDC on the vendor's chain, that the swap keeps at least 98 percent of it and that it has not expired, registers the one-off deposit account on the token itself and sends the USDC there, in one receipt (`Settling`, then `Settled`). The executor names nothing; nobody signs anything by hand. A refunded settlement goes back in front of a person (`Approval`, reason `settlement_failed`), nothing is re-sent on the executor's own; one nobody can confirm is closed by the owner (`close_settlement`, delivered or not).
   - a USDC transfer that fails on the token contract is rolled back in the callback: balance restored, payment marked `transfer_failed`, nothing lost
6. Everything is an on-chain event. The MCP server lets any assistant drive it with the agent's powers, plus two housekeeping tools that use the owner's and the executor's keys when the environment has them (cancel a held payment, sync the DAO's answers).
7. Anyone can re-verify the TEE receipt behind a payment, without the API key and without trusting the agent (`bursar verify`).
8. Orders: the owner records what the company agreed to buy (a purchase order with a total, or a standing order per period). An invoice outside them, or one the model flagged, is held for a person instead of paid on the AI's word. Operators get on-chain roles (approve, manage vendors, manage orders), revocable by the owner.

The AI never chooses an address. NEAR vendors are paid by the contract itself, to the payout the owner recorded. Cross-chain vendors are paid through NEAR Intents by the executor, which can only send the USDC on a quote 1Click signed for that payment: the contract checks 1Click's signature itself (`env::ed25519_verify`) and every field of the quote (the vendor's recorded address as recipient, the exact net amount, USDC on the vendor's chain, a floor, the expiry), then sends the USDC to the one-off deposit account named in it, and only for payments the contract queued; a quote that names any other recipient is refused. A payout recorded or changed by an operator pays nothing until the owner confirms it, every payment carries the payout it was checked against and goes nowhere else, and a changed payout on an invoice is a block, not a payment.

## Live on testnet

| | |
|---|---|
| Policy contract | `treasury.bursar-b48563e6.testnet` |
| Agent (one function-call key) | `agent.bursar-b48563e6.testnet` |
| Executor / relayer | `executor.bursar-b48563e6.testnet` |
| DAO (Sputnik v2) | `bursar-bursar-b48563e6.sputnik-v2.testnet` |
| Test USDC | `tusdc.bursar-b48563e6.testnet` |
| Registry (the list of treasuries) | `registry.bursar-b48563e6.testnet` |

Payments 1 to 6 on that contract are the walkthrough below, run end to end on 20 October 2026 with the invoices read by NEAR AI Cloud inside the TEE (every `attestation_ref` starts with `nearai:`): paid, queued, approved by the DAO and paid, blocked for a changed payout, blocked as duplicate, held because no order covers it. Open `web/dashboard.html?network=testnet&treasury=treasury.bursar-b48563e6.testnet` to see them. The two failure paths of step 4, a DAO rejection and a rolled-back transfer, are payments 6 and 7 on the earlier deployment `treasury.bursar-itlecew5.testnet`.

Mainnet with real USDC and NEAR Intents: the two tables under "Done on mainnet" below, every row a link to the chain.

## Try it: do X, see Y

Prerequisites: Node 22+, Rust stable with the `wasm32-unknown-unknown` target, `poppler-utils` (`pdftoppm`, `pdftotext`), Python 3 with `reportlab` (`pip install reportlab`): step 2 regenerates the sample invoices with your own vendor accounts, and without it the invoices keep the README's accounts and step 3 no longer matches.

```bash
git clone https://github.com/DCSteve96/Bursar.git && cd Bursar
(cd contracts/policy && cargo test && ./build.sh)
(cd contracts/test-usdc && cargo build --release --target wasm32-unknown-unknown)
cd app && npm install && npm test
```
See: `67 passed` from `cargo test`, `bursar_policy.wasm: 462773 bytes` (smaller if `wasm-opt` is installed), and 14 passing app tests (signature recovery, receipt tampering, a real NEAR AI Cloud receipt, offline parser on the four samples, money parsing, a real 1Click quote rebuilt byte for byte and verified against 1Click's key).

**1. Create a testnet account** (any wallet, or [near-cli-rs](https://github.com/near/near-cli-rs), `npm install -g near-cli-rs`, which steps 4, 5c and 9f use too) and put its full-access key in `~/.near-credentials/testnet/you.testnet.json`, which is where near-cli-rs saves it. You need about 25 NEAR: the faucet gives 10 per account, so create three and transfer 9.5 from each of the other two to the first:

```bash
near account create-account sponsor-by-faucet-service you.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service you-b.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service you-c.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near tokens you-b.testnet send-near you.testnet '9.5 NEAR' network-config testnet sign-with-keychain send
near tokens you-c.testnet send-near you.testnet '9.5 NEAR' network-config testnet sign-with-keychain send
```

(A warning that the key could not be saved to the keychain and went to the legacy keychain is fine, backtrace included: the legacy keychain is that folder. The faucet can also answer "error sending request" after creating the account: check it with `near account view-account-summary you-b.testnet network-config testnet now` before creating it again.) Step 2 spends about 19.5 of them (the treasury account with the contract and the DAO bonds, 8 NEAR; the test token, 3.5; the executor, the agent, the vendors); what is left pays the gas of the steps below. RPC defaults to FastNEAR (`rpc.testnet.near.org` answers 429 these days); set `NEAR_RPC` to use another node.

**2. Deploy everything with one command.**

```bash
npx tsx src/cli.ts setup --root you.testnet
```
If it stops on a network error (an RPC node can lag a block behind the account it just created), run the same command again: it resumes where it stopped and skips what exists.

See: sub-accounts for treasury, agent, executor and three vendors (two companies and a freelancer); a throwaway tUSDC token; a Sputnik DAO with you as council and a 0.1 NEAR proposal bond; the policy contract deployed and funded with 15,000 tUSDC; four vendors, each with the tax id it prints on its invoices, one of them a freelancer with a 20% withholding set on it; three orders recorded (hosting 500 USDC a month, purchase orders PO-2026-118 and PO-2026-104); the treasury listed in the public registry (`listed treasury.you.testnet in the registry`); the agent left with a single function-call key; `.env.testnet` written; sample invoices regenerated with your vendor accounts (`written to .../invoices/samples`; git then shows the tracked sample PDFs as modified, which is expected).

**3. Start the relayer and process the inbox.**

```bash
set -a; source .env.testnet; set +a
npm run relayer &
mkdir -p ../invoices/inbox && cp ../invoices/samples/0[1-4]-*.pdf ../invoices/inbox/   # the first four; 6 to 9 are for the steps below, 10 is for the console (9k), 5 is one more ordinary Acme invoice to drop anywhere
npm run agent -- --once --offline      # drop --offline to read with NEAR AI Cloud (needs NEAR_AI_API_KEY)
npm run dev status
```
See, in `status` (the account names are yours; the same four decisions are live on the contract above):

```
#1 acmehosting   AH-0923   480.00 USDC  Paid                      <- NEAR vendor, under caps: paid in the same tx
#2 designco      DC-1107  1250.00 USDC  Queued                    <- Base vendor: waits for the executor (Intents, mainnet)
#3 legalpartners LP-2210  9800.00 USDC  Approval over_threshold dao#0  <- above 2,000: DAO proposal 0 opened by the contract
#4 acmehosting   AH-0924   480.00 USDC  Blocked payout_changed    <- "please note our new wallet": refused
```
and in the relayer log, the agent's meta transactions paid by the executor account.

**4. Approve the big one as the DAO council.** The DAO account is the one `setup` printed, `bursar-<your root without .testnet>.sputnik-v2.testnet`:

```bash
near contract call-function as-transaction bursar-you.sputnik-v2.testnet act_proposal json-args '{"id":0,"action":"VoteApprove"}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send
npm run dev status
```
See: `#3 ... Paid`, and the vendor's tUSDC balance up by 9,800. On mainnet the same proposal shows up in Trezu and is approved with one click.

If the council votes `VoteReject` instead, Sputnik does not call anyone back. Run `npm run dev sync`: the contract asks the DAO for the proposal status and, only on the DAO's own answer, cancels the payment and releases its budget. See: `#N dao#K: Rejected` and `#N ... Cancelled dao_rejected` in `status`, with your payment and proposal numbers (payment 6 on `treasury.bursar-itlecew5.testnet` is exactly that; on your treasury #6 is the next step's invoice, so to try it reject a later proposal). The executor runs this check on every tick.

A vendor whose NEAR account is not registered on the token contract makes `ft_transfer` fail. The contract's callback puts the money back: `Blocked transfer_failed`, balance unchanged (payment 7 on `treasury.bursar-itlecew5.testnet`).

**5. Send a duplicate.**

```bash
cp ../invoices/samples/01-acme-hosting-0923.pdf ../invoices/inbox/again.pdf && npm run agent -- --once --offline
```
See: `Blocked duplicate_invoice`.

**5b. A registered vendor invents an invoice.** Right account, right amount, under every cap: the one case a bank, an employee and most tools would pay. Bursar pays only what the company agreed to buy. `setup` recorded a standing order for Acme (500 USDC a month, one invoice per month) and purchase orders for the two projects; invoice 1 consumed November's hosting slot, invoices 2 and 3 print their purchase order numbers.

```bash
cp ../invoices/samples/06-acme-hosting-1002.pdf ../invoices/inbox/ && npm run agent -- --once --offline
npm run dev status
```
See: `#6 acmehosting AH-1002 290.00 USDC Approval no_order dao#1`: not blocked, not paid, held for a person. With a DAO the council votes; without one the owner or an approver calls `approve_payment` or `cancel_payment`. Invoices the model flagged (urgency, new payment details) are held the same way, reason `flagged`: the AI can add scrutiny, never remove it. `set_order_policy true` makes every invoice need an order; by default only vendors that have orders are held to them.

**5c. Identity on the invoice.** Names can be imitated; a look-alike company has a different tax id, and a mismatch is held for a person. `setup` recorded the VAT number each vendor prints on its invoices, so the contract compares it with the one the model read. Invoice 7 is "Acme Host GmbH", a look-alike with another VAT number that asks to be paid to Acme's registered account:

```bash
cp ../invoices/samples/07-acme-host-gmbh-3001.pdf ../invoices/inbox/ && npm run agent -- --once --offline
```
See: `#7 acmehosting AHG-3001 480.00 USDC Approval no_order+identity_mismatch dao#2`: held for a person, with every reason the contract found (a second Acme invoice in the same period, and not Acme's tax id), not a guess from the name. Now record your own tax id, so every invoice must be addressed to you, and send invoice 8, a real Acme invoice addressed to another customer:

```bash
near contract call-function as-transaction treasury.you.testnet set_company json-args '{"name":"Northwind Studio","description":"","country":"IT","tax_id":"IT01234567890"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send
cp ../invoices/samples/08-acme-hosting-1003-other-customer.pdf ../invoices/inbox/ && npm run agent -- --once --offline
```
See: `#8 acmehosting AH-1003 480.00 USDC Approval no_order+buyer_mismatch dao#3`. Both identity reasons are holds, not blocks: a tax id read wrong must not refuse a real invoice, it must have a person look. In the console the same lives in Vendors ("Identifier", per vendor) and in Settings, Company. Spaces and punctuation in the ids do not matter.

The reading itself is cross-checked without trusting the model: the total must appear in the PDF's text layer, no larger amount may appear in it, subtotal plus tax must equal the total when the invoice shows them, the model's confidence must be at least 0.6, and the currency must be USDC. Each failure is a flag, and the contract holds anything flagged (`Approval flagged`); a scan with no text layer is always held. A misread amount can therefore pay less than the invoice, never more than the document shows, never to another account, and never past an order or a cap.

**5d. Withholding tax, set by your accountant.** Bursar knows no tax rules; the company's accountant sets, per vendor, what to keep back (ritenuta d'acconto in Italy, TDS in India, retencion in Spain and Latin America), and the contract applies it. `setup` registered `consultant`, a freelancer, with country IT and a 20% withholding. Invoice 9 is theirs: total 1,000, withholding 200 shown, net payable 800.

```bash
cp ../invoices/samples/09-studio-bianchi-0044.pdf ../invoices/inbox/ && npm run agent -- --once --offline
npm run dev status
```
See: `#9 consultant SB-0044 1000.00 USDC Paid`, the vendor's tUSDC balance up by 800, and in `status` the line `withheld for the state, to remit 200.00 USDC`: the 200 never left the treasury, it is earmarked: the balance `status` shows still includes it, and the contract spends only the balance minus what is withheld (payments and `withdraw` alike). Budgets and caps count the gross. An invoice that shows a different withholding than the rate set, or shows one for a vendor with none set, is held (`Approval withholding_mismatch`). The same holds for a misreading: read live in the enclave, invoice 9 can come back with the net 800 as the amount, and then it is held this way instead of paid; the `Paid` above is the offline parser's exact reading. The withheld share is the vendor's money paid to the state on its behalf, and remitting and filing stay with the company and its accountant (in Italy the F24, the Certificazione Unica and the 770): Bursar talks to no tax authority. To pay the state, the owner calls `remit_withholding` (in the console: Analytics, "Mark as remitted"): the withheld USDC goes to the owner's own account in one transaction, and the balance and the debt drop together; the company then pays the state with it. A company that paid the state from elsewhere calls `mark_withholding_remitted` instead: the counter goes down and the USDC stays in the treasury, spendable again.

**6. Verify the TEE receipt yourself.** With `NEAR_AI_API_KEY` set, step 3 reads the invoices inside the enclave and writes one receipt per payment in `app/.bursar/receipts/<id>.json`: the exact request and response bytes, the gateway's ECDSA signature, the attestation report with the Intel TDX quote, and the nonce the agent chose. Anyone with that file can check it, without the API key:

```bash
npm run dev verify 1
```
See, one line per check:

```
 ok  bytes                request and response hashes match the stored bytes
 ok  signed_text          signed text is z-ai/glm-5.3-flash:eea8915f29c4cca26e450...
 ok  signature            ECDSA signature recovers to 0x3b753b4406613c5e70ae640508632b600424fa0c
 ok  signer_kind          signed inside the model TEE (provider_tee)
 ok  attestation_signer   attestation report lists signer 0x3b753b4406613c5e70ae640508632b600424fa0c
 ok  attestation_nonce    report echoes our fresh nonce
 ok  quote_report_data    TDX quote report_data binds signer and nonce (mrtd df4d77c857de652b...)
 ok  quote_tcb            quote verified against Intel collateral: TCB UpToDate
 ok  extraction           the claim was built from exactly this model output
 ok  completion_id        completion id 9b1bbd6b036041ea8a8d9b83a7ba26be
 ok  attestation_ref      claim carries nearai:z-ai/glm-5.3-flash:9b1bbd6b036041ea8a8d9b...
 ok  on_chain             payment #1 on treasury.you.testnet carries this reference
verified: the decision was made on this model output, inside an attested TEE
```
Change one byte of the response in the receipt and run it again: `FAIL bytes`, `FAIL signed_text`, `FAIL extraction`, `NOT verified`. Receipts written with `--offline` have no AI receipt and fail before the first check (`FAIL receipt  no AI receipt in this record`), as they should.

To try the enclave reading without a treasury, relayer or NEAR account, read one invoice and stop there:

```bash
NEAR_AI_API_KEY=... npm run dev read ../invoices/samples/04-acme-hosting-0924-fraud.pdf
```
See: the extraction as JSON (`"flags": ["new_payment_details", "urgency"]`), the claim the agent would have sent, the receipt path `app/.bursar/receipts/read-04-acme-hosting-0924-fraud.json`, and the same check list as above minus `on_chain` (without the key the command falls back to the offline parser and says so: no TEE receipt to verify). Nothing is submitted: the vendor id is the model's guess, and only the contract matches it against the allowlist.

Without any key at all, check the receipt behind payment #1 on the live contract (invoice 1, read by `z-ai/glm-5.3-flash` on 2026-10-20, kept in the repo as a test fixture):

```bash
BURSAR_TREASURY=treasury.bursar-b48563e6.testnet npm run dev verify test/fixtures/receipt-01-acme-hosting-0923.json
```
See: all the `ok` lines above, `quote_tcb` included (the Intel collateral is fetched live) and `on_chain` (the reference is read from the contract). The file holds the exact request (with the invoice page as PNG), the exact response, the signature and the attestation report with the TDX quote and GPU evidence: 444 KB, nothing secret.

**7. Drive it from an assistant (MCP).** Add to Claude Desktop, Claude Code or Codex:

```json
{ "mcpServers": { "bursar": { "command": "npx", "args": ["tsx", "src/cli.ts", "mcp"], "cwd": "<repo>/app", "env": { "NEAR_NETWORK": "testnet", "BURSAR_TREASURY": "treasury.you.testnet", "BURSAR_AGENT": "agent.you.testnet", "BURSAR_EXECUTOR": "executor.you.testnet", "BURSAR_USDC": "tusdc.you.testnet", "NEAR_AI_API_KEY": "<your key, or leave it out and pass offline: true>" } } } }
```
Then ask: "submit the invoice at invoices/samples/04-acme-hosting-0924-fraud.pdf and explain the decision" (without a NEAR AI key, add "offline": `submit_invoice` takes `offline: true` and uses the sample parser). See: the tool `submit_invoice` returns `Blocked payout_changed`, and `explain_decision` says why in plain words. `verify_attestation` runs the checks of step 6; `sync_dao_approvals` the DAO check of step 4.

**8. Explorer and dashboard.** Open `web/explorer.html` (a static file, no build; live at `https://bursar.network/explorer`). See: every treasury on the network, read from the registry contract and verified against each policy contract (on mainnet `1 registered, 1 verified`; on testnet a hundred and more, the load test below included, plus yours after step 2; reading them all takes under a minute, with "reading 36 of 112 treasuries..." while it works), the totals across companies (treasury balance, paid out today, this month and all time, decisions, blocked, waiting for a person) and the last decisions of every company, with no vendor names and no invoice numbers. On testnet the registry also holds the load-test treasuries of 21 October (the `treasury.bursar-big-*.testnet` rows, invented companies), with every decision their contracts took on the generated invoices still on chain, read from the chain by this page like any other. The page shows accounts and numbers, never company or vendor names. `web/dashboard.html?treasury=treasury.you.testnet` is one company's own page: balance, caps, vendors with their monthly budget, and every payment with its decision, DAO proposal, destination transaction and attestation reference, all read from the RPC.

**9. Be the customer, from a browser.** The console is `web/console.html` (live at `https://bursar.network/console`) and the door is `web/login.html` (live at `https://bursar.network/login`). Nothing to install: every number is read from the contract and every change is signed in the browser. Opened as a local file, everything works except the wallet door, because wallets answer to a web address (the browser console logs blocked fetches of `builds.json`, `meteor.js` and the sample PDFs, which the pages cover with their `.js` bundles; they are expected): sign in with a wallet on the live site, or serve `web/` with any static server.

Do, with no wallet (works from a local file):
1. Open `web/login.html` and follow the link "Try it with throwaway keys" in the fine print (it opens `web/console.html#start`).
2. Press "Create my treasury".
3. In the first window, fill in your company: name, what it does, country. Leave the tax id empty: the recorded readings below are addressed to a demo company, so another tax id holds them all as `buyer_mismatch`. Press Continue.
4. Wait about a minute in the second window while it creates everything. It costs you nothing: the testnet faucet pays. Save the keys backup it offers.
5. Press Continue. In the third window, choose how invoices are read ("Bursar reading" through Bursar's relay, or your own NEAR AI Cloud key), then press "Open my treasury".

See:
- `OK account`, `OK contract ... with no access key`, `OK company`, `OK agent`, `OK usdc`, `OK vendors`, `OK orders`, `OK registry`, `OK done`, then the console. There is no `OK owner` line: the browser's own key is the owner.
- Overview with 15,000 test USDC and about 1.35 NEAR free: a new treasury holds 6 NEAR, most of it locked by the contract's storage.
- Your treasury counted in the explorer of step 8.

What the page did: it asked the testnet faucet for a payer account, deployed the policy contract from `web/contracts/bursar_policy.wasm` (from `contracts/bursar_policy.wasm.js` when opened as a file), created an agent with one function-call key, minted 15,000 test USDC, registered four demo vendors (paid to the vendor accounts of the README deployment, `acmehosting.bursar-b48563e6.testnet` and the others) and their orders, and listed the treasury in the registry. The vendors are two companies and DesignCo (paid on Base) without tax ids, so the recorded readings keep their outcomes, and a freelancer with 20% withholding and a tax id; set one in Vendors to try that check. If the faucet is slow, the page waits for the account on chain; if it still stops, the button reads "Resume creating my treasury" and carries on from the last step done.

With a wallet, on the live site:
1. Pick the network and press "Continue with NEAR wallet".
2. Choose your wallet in the picker (NEAR Connect: Meteor, Intear, Nightly, Near Mobile and Unity on testnet; HOT and OKX too on mainnet; with the Meteor browser extension installed, the Meteor entry goes through the extension).
3. If your account owns a treasury (the registry lists it and its `get_roles` confirms it), pick it. If it owns none, the same three windows create one.
4. Approve the transaction that adds the key (for an existing treasury it starts when you pick it; for a new one, press "Connect the wallet key"); for a new treasury the wallet also signs `accept_ownership` before that, and one message to lock the vault after it, which the browser key then writes on the contract.

See:
- For an existing treasury, the wallet adds a key limited to that contract: the everyday methods only (orders, approvals and cancellations, DAO proposals and their sync, balance sync, the vault, a request of its own), never a vendor or a payout, the limits, the company record, pause, the withholding and in-flight counters, an operator, the DAO, a withdrawal, a change of owner or roles, or a new contract build. Those the wallet signs itself, and shows you first. What a stolen browser key can still do, honestly: request payments to the vendors already registered as if it were the owner (an owner's requests are not quota-bound, and skip the NEAR floor, so it can also spend the treasury's free NEAR on stored claims within its 0.25 NEAR gas allowance), add or close the orders that cover them, approve what is held when there is no DAO, cancel what is held or queued (with a DAO too), open DAO proposals (0.1 NEAR bonds), and overwrite the vault; what bounds it is the allowlist and its payouts, the per-payment cap, the daily cap and the vendor budgets, none of which it can change. It cannot add a vendor, point one at a new address, lift a cap, unpause the treasury, touch the withheld tax, or move USDC anywhere but to a registered payout. A key added by a build before 6 November could also sign vendor and payout changes; Overview says so and "Replace the key" swaps it for a narrow one in one wallet transaction.
- For a new treasury, the same `OK` lines plus `OK owner ... is owned by you.testnet`: the contract is offered to your wallet account (`offer_ownership`) and the wallet accepts it (`accept_ownership`, one signature).
- "you.testnet, owner, wallet key" at the bottom of the sidebar.

The payer account's key stays in the browser (and in "Download the keys") to fund invites and the DAO, which need NEAR deposits a wallet key cannot attach; on mainnet it holds no power over the contract, and on testnet it is also the treasury's executor. The other doors are an invite link from a colleague and a keys file from an earlier treasury. No password and no server.

**9, continued: the recorded readings.** These are the real receipts the enclave signed on 20 October, fetched through the relay (from `samples/readings.js` when the console is opened as a file). Use a treasury with no DAO yet: create the DAO after this, or payment #1 opens a proposal instead of waiting for "Approve".

Do:
1. Open Invoices and load the recorded readings one at a time.
2. Press "Request payment" on each, in this order: Legal Partners, Acme with a new wallet, Acme, DesignCo.
3. In Attention, press "Approve" on the Legal Partners payment.

See:
- Every reading verified in the page with the same checks as `bursar verify`, Intel collateral included.
- Legal Partners `#1 Approval`, then `Paid` once you approve it (signed by the owner, since there is no DAO).
- Acme with a new wallet `#2 Blocked payout_changed`.
- Acme `#3 Paid`.
- DesignCo `#4 Queued`, which step 9j settles.
- The fifth reading, Acme with an invoice nobody ordered, is for step 9e.

**9, continued: read a PDF live.**

Do:
1. In Invoices, drop one of the files in `web/samples/`, for example `04-acme-hosting-0924-fraud.pdf`.
2. Press "Request payment".
3. Press "Download receipt JSON", then in `app/` run `npm run dev verify <file>`.

See:
- The PDF rendered to PNG in the browser, the attestation fetched for a fresh nonce, and the enclave's answer from `Qwen/Qwen3-VL-30B-A3B-Instruct` in 3 to 5 seconds.
- The receipt checks of step 6, the Intel collateral check included.
- The contract's decision with the transaction link: `Blocked payout_changed` for invoice 4. Other files get whatever the treasury's state allows: after the recorded readings every order is used, so an ordinary Acme invoice such as 5 is held `no_order`, and `Paid` needs an order that covers it (add one in Orders).
- `verify` passing on this treasury: after "Request payment" the file carries this treasury's payment and transaction and names the treasury, a refused payment included.

Notes on the reading:
- "Bursar reading" is a hackathon demo convenience. The page goes through Bursar's relay (`relay/worker.js`, a Cloudflare Worker that holds a NEAR AI Cloud key paid by the team and forwards the bytes untouched, so the signature still verifies; daily caps apply). A company brings its own NEAR AI Cloud key, and then the invoice goes from the browser straight to the enclave and never passes through Bursar (an invoice received by Telegram still reaches the browser through the relay).
- The page signs `request_payment` with the agent key (plain borsh plus ed25519, no NEAR library). The agent account needs a little NEAR for gas on this direct path (`setup` leaves it 0.5); the CLI agent goes through the relayer and needs none. If the gateway answers 502 or 524, the page retries on its own.
- On 1030 invented invoices of ten invented companies (five layouts, 207 noisy scans without a text layer, 100 multi-page, 67 with new-bank-details fraud, 25 with a deposit already paid, 30 duplicates), read 8 at a time through the relay: 1030 read, 1030 signed, 0 errors, amount right on 1029, payout right on 1006. The payouts read wrong were garbled addresses on scans, refused by the page or blocked by the contract, never paid.
- The claim takes the amount from the string the model copies off the page, parsed here (European 1.234,56 included) and reconciled with the printed subtotal and tax. A notice of new payment details that points at the registered payout is not a hold; a different payout is refused whatever the notice says.
- The first receipts in this README were produced by `z-ai/glm-5.3-flash`, the model Bursar used until 21 October. They verify the same way: the model name is part of the signed text.
- "Use the demo treasury" points the page at the README deployment instead (read-only without its agent key).

**9, continued: the rest of the console.** Pages: Overview (balance, what waits for a person, last decisions), Invoices (read, receipt, decide), Attention (approve or cancel what is held, see what was refused and why), Vendors (allowlist, payouts, budgets), Orders (purchase orders and standing orders), Analytics (spend by vendor and by month, straight from the payments), Settings (company, limits, strict order mode, operators with on-chain roles, keys). Several treasuries live side by side in the switcher at the top of the sidebar.

- **Invite a collaborator.** Do: in Settings, under "Invite a collaborator", pick a role (approve, vendors, orders) and press "Create the invite". See: an account created for them with one key limited to the methods of that role, the role recorded in the contract, and a link that carries the key after the hash sign, so it never reaches a server; send it however you like. Whoever opens it is signed in as that account with that role and nothing else. "Remove" next to the operator revokes it on chain.
- **Create a DAO.** Do: in Settings, "Governance", pick the council (you, operators, any NEAR account) and press "Create the DAO". See: the Sputnik factory called with a 6 NEAR deposit on testnet (the DAO's own account and storage, paid by the payer account), 2 NEAR sent to the treasury for proposal bonds, and the contract pointed at the DAO. From then on every held payment opens a proposal, and council members vote in Attention (or in Trezu on mainnet).
- **Receive invoices by Telegram.** Do: in Settings, press "Connect a Telegram chat", open the link, press Start, and post a PDF in that chat (you, a colleague, or a vendor in a group). See: the PDF in the console's Inbox with the sender and the file name, nothing read yet. Press Read: the same enclave reading and contract decision as a dropped file, and the bot tells the chat the outcome with the transaction link. The relay keeps the sender, the name, Telegram's file reference and the approval state; the PDF stays on Telegram until Read, when the relay fetches it for the console (`relay/README.md`, "Telegram inbox", for the bot setup). The owner can also approve from Telegram: step 9h.

`web/docs.html` explains all of this in one page. The workflow in `.github/workflows/pages.yml` publishes `web/` with GitHub Pages (enable Pages with source "GitHub Actions" in the repository settings).

**9a. On your phone.**

Do:
1. Open `https://bursar.network/console` on the phone.
2. Add it to the home screen (Safari: Share, "Add to Home Screen"; Chrome: the install prompt or the menu's "Install app").

See:
- Bursar as an app with its own icon, full screen, opening on the console.
- The pages you visited open again without network; the chain and the relay are always asked live.

It is a manifest, three icons and a small network-first service worker (`web/sw.js`), nothing else: keys stay in the page's own storage.

**9b. Charts and the accountant's report.**

Do:
1. In the console, open Analytics.
2. Press "Download the Excel report".
3. Press "CSV of all payments".

See:
- Spend by month (the lighter top of a bar is the withholding kept for the state), spend by vendor, the mix of decisions, and every payment grouped by vendor with gross, withheld and net (net is what the vendor received; a cross-chain payment the executor has not delivered yet shows as "on the way", in its own column in the files too).
- `bursar-<treasury>-<date>.xlsx` with five sheets (Summary, Payments, By vendor, By month, Withholding), amounts as numbers, one row per decision with its reason, invoice hash and enclave completion id.
- The CSV is the Payments sheet alone. Both files are built in the browser from the contract; nothing is uploaded anywhere.

**9c. Lose the browser, keep the company.**

Do, to save and restore:
1. Sign in with the wallet and connect a Telegram chat (Settings).
2. In Settings, press "Save to the vault": the wallet signs one message (no wallet transaction) and the browser key writes the encrypted blob with `set_vault`.
3. Open a different browser, sign in with the same wallet and pick the treasury.
4. Press "Unlock with the wallet".

See:
- `vault on chain: saved <now>, up to date`, and `get_vault` on the contract returning an opaque `v3:...` string (encrypted in the browser; the contract never reads it).
- In the second browser, the green strip "its contract keeps a vault with them", then the Telegram inbox back with the same token. Nothing was stored anywhere but your contract, and its contents are unreadable without your wallet; the list of admitted devices (browser, system, wallet public key, date) is visible on chain.

Do, for a device whose wallet key is new (the wallet app on your phone holds a different key for the same account):
1. On the phone, press "Ask to admit this device" (one transaction; it leaves a public key on the contract).
2. On the first device, open Settings, Keys.
3. Back on the phone, press "Unlock with the wallet".

See:
- The first device admits the phone by itself (one transaction, `admitting Safari on iPhone...`): the request carries a signature by the phone's wallet key, and the page checks on chain that this key is one of your account's own full-access keys. A request signed by any other key, a browser key included, shows Admit and Refuse with the reason next to it.
- The vault opens on the phone, and from then on its own signature does.
- Under Settings, Keys, `admitted devices` lists each device by browser, system, wallet key and date; "forget" shuts a lost one out.

Do, with no device left to admit from (the executor key is gone with the browser):
1. As the owner, press "Replace the executor from this device".

See:
- The wallet creates a new executor sub-account with one key limited to `settle`, the two marks and `sync_dao_proposal` on this treasury (0.2 NEAR), then calls `set_roles`.
- `get_roles` on the contract naming the new executor, and "Settle via Intents" back in Attention.

A person in the console can also press "Request payment" without the agent key: `request_payment` accepts the agent, the owner and the operators, and decides the same way.

**9d. One chat per vendor.**

Do:
1. In Settings, Telegram inbox, pick a vendor in "Who is this chat for" and press "Connect a Telegram chat".
2. Open the link in Telegram and press Start.
3. Post a PDF in that chat.
4. Connect a second chat for DesignCo, post Acme's invoice there, Read it and press "Request payment".

See:
- The bot answering "Connected ... for the vendor Acme Hosting: invoices from here are expected from that vendor".
- The PDF in Inbox under "Acme Hosting".
- For Acme's invoice in DesignCo's chat, the flag `chat_vendor_mismatch` and the contract's answer `Approval (flagged)`: a hold for a person, because the chat and the paper disagree.
- Under Settings, "Connected chats", every chat with the vendor it is for; change it or disconnect it there.

**9e. Know the answer before you ask.**

Do:
1. Load any recorded reading or read any invoice, and look under the claim, before the button.
2. In Vendors, deactivate Acme Hosting, then load "Acme, an invoice nobody ordered".
3. Press "Request payment", then reactivate Acme.

See:
- "will pay", "will queue" (cross-chain, for the executor), "will wait: ..." or "will be refused: ...". It is `preview_payment`, a view method that runs the contract's checks on the contract's state without recording anything.
- "will be refused: vendor deactivated by the owner" before you press anything.
- The same `Blocked vendor_inactive` when you press.

**9f. Money that arrived without a call.**

Do:
1. Open Overview and look at the "Top up" card.
2. Send 500 test USDC to the treasury the console made in step 9 with a plain transfer (its account is in the Top up card; the console's treasuries use the shared test token `tusdc.bursar-b48563e6.testnet`, whose open `mint` gives you the 500 first):

```bash
near contract call-function as-transaction tusdc.bursar-b48563e6.testnet mint json-args '{"to":"you.testnet","amount":"500000000"}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction tusdc.bursar-b48563e6.testnet ft_transfer json-args '{"receiver_id":"<your console treasury>","amount":"500000000"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as you.testnet network-config testnet sign-with-keychain send
```

3. Reload Overview and press "Sync balance".

See:
- In the card: the treasury account to send USDC to from any wallet or exchange (as text with Copy, and as a QR code), the NEAR the account has free of its storage (with a warning when it runs low), and for the owner "Deposit USDC" and "Add NEAR" (on testnet also "Mint 10,000 test USDC"). A deposit made from the page raises the balance at once: it is an `ft_transfer_call`, which the contract counts in the same transaction.
- After the plain transfer, a strip at the top of Overview: "The USDC contract holds 500.00 USDC more than this treasury has on its books" and a "Sync balance" button. If the token's balance cannot be read at that moment (a busy RPC), the card says so instead.
- After Sync, the balance up by 500.00 and the notice gone. `balance_synced` in the log carries the old, new and in-flight amounts.

Why: a wallet or an exchange sends USDC with a plain `ft_transfer`, so the tokens are in the account but the contract's books do not know. `sync_balance` (owner or operator) has the contract ask the token contract itself what it holds, a cross-contract `ft_balance_of`, minus the transfers it sent whose callback has not landed, so nothing is counted twice. Nobody types a number.

**9g. Upgrade the contract from the console.** A treasury created in a browser has no full-access key anywhere, by design.

Do:
1. Open Settings and look at the build the treasury runs.
2. When a new build of the policy contract ships, press "Upgrade contract" as the owner and let the wallet sign.

See:
- The build label: the treasury's code hash checked against `web/contracts/builds.json`.
- After the upgrade, the build label changed and every payment still there.

How: the wallet signs `upgrade` with the new wasm as its argument, and the contract deploys it onto itself and runs `migrate` in the same batch, which brings the stored state to the new layout. It is idempotent: a state already in the current layout is left alone. A treasury on a build from before 20 October 2026 needs one intermediate upgrade first, which the console performs when it sees such a build; none of the registered treasuries is on one. Treasuries deployed before this method existed are upgraded once with their treasury key (`near deploy`), after that from the console.

**9h. Approve from your phone.**

Do:
1. In Settings, Telegram inbox, press "Connect your Telegram as approver", open the link and press Start.
2. Post a PDF in a vendor's chat.
3. In your own chat, press Approve under it (with several waiting, reply to the one you mean, or type yes or no under it).
4. In the console's Inbox, press Read, then "Request payment".

See:
- The bot answering "You approve invoices for ... from here".
- The invoice in your chat as a message with the PDF attached, the sender, the file name, and two buttons, Approve and Reject.
- After Approve, the vendor's chat reading "accepted by the company, being processed", and the Inbox row reading "approved, by you: press Read to send it to the contract".
- After "Request payment", the outcome under your message: `Paid: AH-0923, Acme Hosting, 480.00 USDC` with the transaction link, or `Held: ... Reason: amount at or above the approval threshold. Open the console to review it and approve with your wallet` with a link straight to Attention, or `Blocked: ... Reason: payout on the invoice differs from the vendor record`. The vendor's chat reads only "paid", "under review at the company" or "declined", never the reason.

More from the same chat:
- **Many at once.** Type `approve all` in your approver chat: see the list of what waits and one button, "Approve all N". In the console, Inbox has "Approve all waiting (N)", and Attention has a checkbox per held payment with "Approve selected" and "Cancel selected" (four `approve_payment` calls per signature; with a DAO, "Vote approve selected", one vote per proposal). Each invoice is still a decision of its own on the contract, with its own limits: bulk means fewer signatures, never fewer checks.
- **Reject.** Press Reject instead: the row leaves Inbox and the vendor reads "declined". Decide in the console instead of the phone: your Telegram message gets the same outcome under it.
- **Trusted vendors.** Under "Trusted vendor", tick "accept without asking" when you connect a vendor's chat (or the "trusted" box next to it under Connected chats). Its invoices skip the question, you only get a notice, and the vendor reads "Accepted: the treasury contract decides next". The contract still applies every rule, so a changed payout, a cap, a missing order or a flag is held or blocked exactly as before.
- **With the agent running.** A company that runs the agent with the inbox token from Settings, Keys, sees it take approved invoices on its own, and with trusted vendors nobody touches anything between the PDF and the payment:

```bash
BURSAR_RELAY=https://bursar-relay.<you>.workers.dev BURSAR_INBOX_TOKEN=<token> npm run agent -- --direct
```

See: `telegram AH-0923.pdf -> payment #N Paid`.

Why it is safe: Approve on Telegram is a yes recorded on the relay, nothing more. Whoever presses Read (or the company's agent) signs `request_payment`, a method that can only ask, and the contract applies the same caps, thresholds and holds; a held invoice is approved in the console by the owner, an approver or the DAO council, never from Telegram. No NEAR key lives on the relay: it holds only the NEAR AI Cloud key for the shared reading and the Telegram bot token. Only the Telegram user who pressed Start with your code can decide, in a group too.

**9i. Hand the company over in two steps.**

Do:
1. In Settings, Ownership, type another account in "Offer the treasury to" and press "Offer ownership" (one transaction).
2. Sign in from the offered account (any browser, its own wallet): the login page lists only the treasuries an account owns, so type the treasury's account under "Was a treasury offered to you?" and press "Open it" (the page checks the offer on the contract and adds a key for it).
3. Press "Accept ownership" (one transaction).

See:
- After the offer, `get_ownership_offer` on the contract naming that account, `get_roles` unchanged, and "Withdraw the offer" available.
- On the offered account, "Accept ownership".
- After accepting, `get_roles` naming the new owner, and the old owner without any owner method (`set_company` from it: `only the owner`).

There is no `transfer_ownership` any more: nothing changes until the named account accepts, the owner can withdraw the offer until then, and the wallet shows the account before signing (an offer to the wrong account is still an offer).

**9j. Settle on a quote the contract verifies (testnet, with a stand-in for 1Click).** NEAR Intents has no testnet, so with `?intents=stub` the page plays 1Click and signs its quotes with the test key the contract's own tests use.

Do:
1. Open the console with `?intents=stub` before the `#`, for example `web/console.html?intents=stub#attention`.
2. In Attention, press "Settle via Intents" on the DesignCo payment queued in step 9. On a treasury where it is not queued, load its recorded reading or drop `02-designco-1107.pdf` and request it first.
3. Confirm in the dialog.
4. Read `get_payment` for that id on the contract.
5. In `contracts/policy`, run `cargo test settle`.

See:
- The page pointing the treasury at the test signer once (`set_quote_signer`, signed by the owner).
- The quote dialog: what the vendor receives and at which address, what the treasury sends, a 64-character deposit account, and "signed by the test signer standing in for 1Click (stub), checked here and by the contract" (on mainnet: "1Click, checked here and by the contract").
- One transaction by the executor key, `settle` with the signed bytes and the signature. The contract verifies the signature, checks the recipient, the amount, the asset, the floor and the expiry, registers the deposit account on the test USDC and sends the net amount in the same receipt.
- `get_payment` showing `deposit_address` (an implicit account the executor never named) and `quote_id` (the base58 hash of the signed bytes); within half a minute the stub reports delivery and `mark_settled` closes it.
- `cargo test settle` running a signed quote for another recipient, another amount, a fee over 2 percent, another chain, an expired one, a named deposit account, a wrong signature and a wrong key: every one refused, the test asserting its reason, and nothing moves.

Who signs: a treasury made with throwaway keys names its owner as the executor, and one made on testnet with a wallet names the payer account; both keys are in this browser. A treasury with its own executor (mainnet) needs that key here (Settings, Keys).

**9k. Let the page be the executor.**

Do:
1. Open the console with `?intents=stub` as in step 9j (on testnet the switch appears only with it; on mainnet it is always there). In Attention, above the queued table, turn on the switch "Automatic settlement is off".
2. Read `web/samples/10-designco-1108.pdf` (DesignCo again, 300 USDC, no purchase order) and press "Request payment".
3. In Attention, press Approve on it.

See:
- The box turning green and saying what runs.
- `Approval no_order` for invoice 10, then `Queued` after Approve.
- Within about 30 seconds (the loop ticks every 30 s, the settlement takes a few more), step 9j with no dialog, ending `Settled`.

Three failed attempts leave a payment to a person, with the reason. The same loop runs headless with `npm run executor`.

**9l. The transactions behind each payment.**

Do:
1. In Analytics, look at the "on chain" column of "All payments, by vendor".
2. Press "Download the Excel report" or "CSV of all payments".

See:
- One link per transaction the page can match: the request and the last change from the contract's two timestamps, the settle and the approval of a held payment from their place between them (a payment approved and then settled keeps only the settlement's time, so its approval is found by order), and the destination chain transaction, in time order.
- The same links as columns in both files (hyperlinks in Excel).
- The NEAR transactions as links, read from the nearblocks API v3, on testnet too. A payment the CLI agent requested through the relayer reads `-`: its outer transaction is a meta transaction addressed to the agent, not to the treasury. A payment settled through the stub shows `base stub` for its destination. On mainnet it is the table in step 10.

The contract keeps timestamps, not hashes: the page matches them to the treasury's receipts read from nearblocks.

**10. Cross-chain payout (mainnet only).** NEAR Intents has no testnet. On mainnet the whole thing runs from the browser: sign in at `https://bursar.network/login` with a mainnet wallet, press "Create my treasury" and see the wallet fund a payer account the page creates (one signature, about 7 NEAR), the payer create the treasury with the contract inside and no access key, the agent with its one key, the executor with a key limited to `settle`, the two marks and `sync_dao_proposal`, and the USDC registration, then the wallet accept the treasury (a second signature, since ownership moves in two steps) and add its key (a third); 4.7 NEAR stay the contract's storage on your own account; add a vendor on Base in Vendors and deposit USDC from Overview, Top up. Submit an invoice for that vendor (`web/samples/mainnet/` holds three small ones, 10 and 5 USDC on Base and 5 USDC on NEAR, made with `make_invoices.py --mainnet-demo`): `Queued`. In Attention, "Settle via Intents" (with a 1Click partner key pasted in Settings, see the limits below): see the 1Click quote (what the vendor receives, the one-off deposit account, 1Click's signature checked in the page), the executor key call `settle` with the signed quote, the contract verify the signature and every field of the quote, register the deposit account on the USDC contract itself and send the USDC in one receipt (your wallet signs nothing), and the page follow the swap until the vendor's chain confirms, then `mark_settled` with the destination transaction hash. Or turn on "Automatic settlement" in Attention and watch it happen with no click. The same loop runs headless with `npm run executor -- --once` and the executor key in the keystore.

**Done on mainnet, 2 and 3 November 2026.** Everything above ran for real, from a browser, with small amounts. Judges can check each step on chain; every link is a public explorer. Payment #1 (2 November) was settled with the build of that day, where the owner registered the deposit account first (`set_settlement_account`); payment #4 (3 November, second table) was settled by the current build, on a quote whose signature the contract verified itself, and that method is gone.

| Step | On chain |
|---|---|
| Treasury created from the browser (a payer account the page made, [`5oZXs9WV...`](https://nearblocks.io/txns/5oZXs9WVqH4tN3iN5EVnWVYA4HQpAUXCAHsEzwiMexUR), then handed to the wallet with the one-step `transfer_ownership` of that day's build, [`8eQNejfW...`](https://nearblocks.io/txns/8eQNejfWM94JvzDrP63j2oxNDUoZ4b39sUjK8m9NSqGd); today's build offers and the wallet accepts, step 10), no access key, listed in the registry | [`treasury.bursar-8ccac085.near`](https://nearblocks.io/address/treasury.bursar-8ccac085.near), owner `badfrog6063.near`, in [`registry.bursar.near`](https://nearblocks.io/address/registry.bursar.near) and on the [explorer](https://bursar.network/explorer?network=mainnet); the agent's one key: [`14L7fkeA...`](https://nearblocks.io/txns/14L7fkeAkUAP62Nznm2ekvxhLTnRxDxg6bPkjtC4T71w) |
| Invoice for 10 USDC to a vendor on Base, read in the enclave: `Queued` | `request_payment` by the agent's function-call key, [`Bg1Cett5...`](https://nearblocks.io/txns/Bg1Cett5fRg1WmVzoY5BE7Wwwj7RagHSiceUyCKRxBw9) (payment #1) |
| Invoice for 5 USDC to a vendor on NEAR (for the demo the vendor's payout is the owner's own account, `badfrog6063.near`): held, because the model flagged it (`payment_needs_approval 2:flagged`), then approved by the owner's wallet and paid in that transaction | `request_payment` [`Hcx5Scqm...`](https://nearblocks.io/txns/Hcx5Scqm6mNXAmcasemJXfskxNkHsRfCizUwnna1NSof) (payment #2), `approve_payment` [`8mKk1126...`](https://nearblocks.io/txns/8mKk1126EuqDZ1FBpr325Rw9qm3GcMXGtUbtrotvZqNm): the contract's `ft_transfer` to the vendor is inside it |
| The executor replaced from a phone (its first key sat in another browser's vault) | the wallet creates `exec-8233d0.badfrog6063.near` with one key limited to `settle` and the marks, [`GMtWSpGW...`](https://nearblocks.io/txns/GMtWSpGWT5FzWTtNCXFPwJMn7bSneoWiEGSjbc5jHfEG), then `set_roles`, [`BeF1d6fb...`](https://nearblocks.io/txns/BeF1d6fbZtZnPy6ALSKfkRazbd9nugnxMfpYvH9dGDUd) |
| The 1Click deposit account registered, by the owner | `storage_deposit` on the USDC contract [`FMdZGyVi...`](https://nearblocks.io/txns/FMdZGyViJt2LjqWh21ypiHPXBDbnFn5eaLEsiev3xz5e), `set_settlement_account` on the treasury [`6ZQwKJPL...`](https://nearblocks.io/txns/6ZQwKJPLrJB4cxvdywPxkfTTUcc1hZn76LdSFqixfmqV) |
| `settle` by the executor: 10 USDC leave the treasury for that account and nowhere else | [`CcHpJwRm...`](https://nearblocks.io/txns/CcHpJwRmZCcCM1FhGakNzbUTGLeHLNg73mQW5S3AyQVx) |
| The vendor paid on Base, 9.996381 USDC | [`0x9784ec...`](https://basescan.org/tx/0x9784ec838c10f1622132f994b75d0e7b2fc4ee91d3be730695f363bfb3713b15), 1Click status `SUCCESS` |
| `mark_settled` with that Base hash: payment #1 is `Settled` | [`G3W6LMv1...`](https://nearblocks.io/txns/G3W6LMv1qbJnNcUzdUUmUqeLSp5MhnvYUzrLj5HbaJhU); `get_payment {"id": 1}` on the treasury shows `dest_tx` |

**3 November, the current contract.** The owner upgraded the treasury to the build in this repository, and the console settled the next invoice on Base by itself, with the automatic settlement switch on:

| Step | On chain |
|---|---|
| The treasury upgraded by its owner's wallet (no key on the treasury) | `upgrade` [`6Gm41Co8...`](https://nearblocks.io/txns/6Gm41Co8GybdZh6SD5R6E9td2QZX2j43tMTHEX15U4yS) |
| Invoice DC-2003 for 5 USDC to the vendor on Base, read in the enclave: `Queued` | `request_payment` by the agent's key, [`DCUbgteeC...`](https://nearblocks.io/txns/DCUbgteeCyb9ZvuER59LHxckivnGbph8RWM1CtS3Kr4S) (payment #4) |
| The replaced executor key tries to settle it: refused three times, nothing moves | [`7aZgiqST...`](https://nearblocks.io/txns/7aZgiqSTRe1tBrysrQNAa2BnrqgEBua9i8uZDYzPsMtM), [`HKjyzeDu...`](https://nearblocks.io/txns/HKjyzeDub9iLBdKkqsMKZiv3Ay75LZ1GsZC8i6PHM8Su), [`CWAnVgCr...`](https://nearblocks.io/txns/CWAnVgCriJWNKjgD5bq466EWcTiVGUhjPgDi54MEmSff), signed by `executor.bursar-8ccac085.near`, no longer the executor in `get_roles` |
| `settle` by the current executor with the bytes 1Click signed and the signature: the contract verifies both and sends 5 USDC to the deposit account of that quote | [`9NindR1c...`](https://nearblocks.io/txns/9NindR1cjsbgAGroQbewxRsYfjsYkdET3TVzgzpbsbKJ); `get_payment {"id": 4}` shows `quote_id` and `deposit_address` |
| The vendor paid on Base | [`0x46bff9...`](https://basescan.org/tx/0x46bff94770ad6230a06d5e694be29aa0ff72d231bb1f7a8a479ca94a990d1d13) |
| `mark_settled` with that hash: payment #4 is `Settled` | [`FzZ1VoGv...`](https://nearblocks.io/txns/FzZ1VoGvv2zqQGS1AJAHGAcVHqFmEibeNv4qPsXkbNTt) |

Two things happened along the way that this README now covers: the reading model at NEAR AI Cloud answered 502 and the console switched to the fallback model (the receipt names it), and 1Click answered "Quoting for this pair is not available" and then 521 for most of the afternoon before quoting again. The amounts were small on purpose; the contract, the keys and the flow are the same at any size.

<details>
<summary><strong>Security reviews: three internal rounds by separate AI reviewer agents, every contract finding reproduced by a unit test</strong> (click to read what they found and what changed)</summary>

**Security audit (21 October).** Four separate reviews of the contracts (authorization, accounting and asynchrony, policy logic, storage and gas) plus a line-by-line read, every finding reproduced by a unit test before the fix, then a second round on the patched code. What they found and what changed: a held payment could be approved after the owner paused the treasury or switched the vendor off (approval now re-checks both); the executor could send a queued payment to any NEAR account by naming the right recipient in the quote (it could then only pay the Intents deposit account the owner registered; since 3 November it pays only on a quote 1Click signed for the vendor's recorded address, verified by the contract); an operator with the vendors role could redirect a held payment by editing the payout before the council voted (each payment carries the payout it was checked against, and a payout recorded by an operator pays nothing until the owner confirms it); cancelling yesterday's hold freed today's daily cap (counters are released only in their own day and month); withheld tax sat inside the spendable balance (it is now set aside, `remit_withholding` moves it to the owner for the state); a stolen agent key could fill the contract's storage with oversized claims or drain its NEAR into DAO bonds (claim fields are bounded, non-owner callers get daily quotas of requests, refusals and holds, no proposal opens without NEAR for the bond); a bill split into many small invoices met no one (five autopaid invoices per vendor per day, then a person); duplicates were caught only on the exact number (now on the normalized number and on the file hash); a refunded Intents settlement was stuck forever (`mark_settlement_failed` returns it to the queue); a transfer callback that never ran blocked `sync_balance` for good (`reset_in_flight`); a DAO could not be removed (`clear_dao`); ownership could go to the agent key (refused); event logs could be forged with a quote in a vendor id (escaped); the registry trusted any entry (the explorer and the login page now check the code hash of the contract against `web/contracts/builds.json`, and the registry's `claim` asks the treasury itself who owns it). A second round on the patched code found that the first fix for refunded settlements let the executor pay the same queued payment twice; a refunded settlement is now taken back on the books only once the token contract shows the USDC back on the account (since the third round it then waits for a person instead of returning to the queue), quotas are per caller, DAO proposals opened for a non-owner are limited per day and a person can open the missing ones, and the relayer caps gas and calls per hour. What the contract still trusts, on purpose: the claim's flags and tax ids come from the reading and can only add scrutiny, never remove a block; the executor is trusted for the timing of the payments the contract queued, within a quote 1Click signed; the approval threshold is per invoice, the daily cap and the vendor budgets are the bounds that hold whatever the agent does.

**Third round (24 October).** Five separate reviewer agents, told to be aggressive, on the contracts, the relay, the console, the agent and the relayer; every contract finding reproduced by a unit test before the fix (65 tests at the time). Contracts: approval and settlement checked the net amount against the balance instead of the gross; releasing a hold from an earlier period freed the current period's allowance; a settlement nobody confirmed had no way out (the owner can now `close_settlement`, delivered or not, and a refunded one waits for a person instead of being re-sent); the agent, executor, operator and DAO roles could overlap (`setup` and the wallet wizard keep them distinct now; the testnet wizard with throwaway keys names the owner as executor on purpose, step 9j); an invoice larger than its purchase order fell back to the standing order; an operator with the vendors role could switch a vendor back on or change its tax id and withholding (owner only now); invoices without a number collided; the withholding tolerance was a percent instead of rounding; a held claim was stored at full size; a failed DAO proposal left the duplicate keys in place; a vendor's order index was missing after migration; `request_payment` refuses when the account is low on NEAR for storage, instead of failing halfway. Off chain: the inbox pairing is signed by the treasury's owner and checked against `get_roles`, each chat is bound to one treasury, and there is no free-text route; the relayer verifies the delegate's signature, that the key is on the agent's account and the expiry before paying any gas, with per-address limits; the treasury account is created together with its contract and never gets an access key, by `setup` and by the console alike, so only the owner's methods can change it, `upgrade` included; the agent checks the TEE receipt's signature, nonce and quote binding before claiming on it (the Intel collateral check is `bursar verify`'s), flags an invoice from a vendor's chat that names another vendor (`chat_vendor_mismatch`), runs poppler with timeouts and per-file folders, and no longer loads a JavaScript PDF parser; the executor quotes EXACT_INPUT on the net the contract actually sends, caps the fee at 2 percent and stops after three failed attempts; the console confirms unknown RPC and relay parameters, refuses an invite for a treasury whose keys it already holds, routes the owner's sensitive methods through the wallet, pins its CDN modules by integrity hash where the import map allows (the DCAP verifier from esm.sh is pinned by version only), and locks each vault with a salt of its own (a Content Security Policy with script hashes was tried and dropped: NEAR Connect runs each wallet's code in an iframe that inherits the page's policy, and every non-extension wallet stopped initializing; the pages keep `object-src 'none'`, `base-uri` and `form-action` only). The round also caught its own mistake: the first fix left `upgrade` with too little gas for the deploy fees of a 471 KB build (the build of that day; today's is 462,773 bytes), which showed up as a failed owner upgrade on the key-less demo treasury; the reserve is now 60 TGas, checked by a real owner upgrade on a treasury with no key before the demo was touched again. Left on purpose at the time: an owner's wallet could be talked into signing `transfer_ownership` (since replaced by two-step ownership, step 9i); the executor is trusted for the destination within the vendor record; the registry remains a hint, verified against the contract by every reader.

</details>

**Unit tests:** `cd contracts/policy && cargo test` (67 tests, one per policy rule and one per finding of the three review rounds above: pays under threshold, queues cross-chain, blocks changed payout, blocks duplicates and caps, DAO approval flow, owner approval without a DAO, purchase orders consumed then held, standing order one invoice per month, vendors without orders unless strict, model flags add scrutiny, operators and roles, proposal id recorded by callback, failed proposal releases budget, DAO rejection cancels, failed transfer restores balance, executor cannot redirect funds, only the agent, the owner or an operator can request (a stranger cannot), chain address case, two-step ownership, settlement only on a quote signed by 1Click, tax ids on the invoice, withholding kept back for the state). `cd contracts/registry && cargo test` (7 tests: register and look up, fee, no hijacking, a claim evicts the squatter, strangers cannot pile entries on an owner, owner updates and removes). `cd app && npm test` (14 tests: receipt verification against tampering, a real NEAR AI Cloud receipt verified offline and rejected after a one-byte edit, offline parser, money parsing and amount bounds, and the bytes of a real 1Click quote hashed and checked against 1Click's signature the way the contract does).

## What comes next

The hackathon build is the demo above. The [roadmap](ROADMAP.md) has the full plan; in short: a mainnet pilot with a handful of companies, an email inbox with the same approvals as Telegram and push notifications on the installed phone app before the end of 2026; NEAR Business as the vault behind a treasury, approval chains and policies per department, exports for auditors, structured e-invoices and a cash forecast in Q1 2027; ERP connectors, dynamic discounting, budgets for fleets of AI agents and a native app in Q2 2027. The [white paper](WHITEPAPER.md) explains the principle, the trust model and the economics. The principle does not move: the AI reads, the contract decides, a dumb executor moves the money.

## NEAR features used, and why

| Feature | Where | Why it matters here |
|---|---|---|
| Function-call access keys | `setup` step 7, `agent` | The agent's only key can call one method on one contract. A stolen agent key can only ask: claims within the caps and budgets for registered vendors (and within their orders, for vendors that have them) are paid, the rest is held or refused, and the contract's daily quotas per key and the five autopaid invoices per vendor per day bound even that. |
| Meta transactions (NEP-366) | `relayer.ts`, `near.ts` | Through the relayer the agent pays no gas; the relayer only forwards `request_payment` from the agent. The direct path (console, MCP) pays gas from the agent's 0.5 NEAR. |
| Sub-accounts | `setup.ts` | Agent, executor and treasury are separate accounts under the company. |
| NEAR AI Cloud (TEE) | `ai.ts` | Invoices are sensitive. Inference runs in a TEE, with attestation and a signed receipt stored next to the payment. |
| NEAR Intents (1-Click) | `executor.ts`, `quote.ts`, console | Vendors get USDC on their chain. The contract verifies 1Click's signature on the quote and checks its recipient, amount, asset, floor and expiry itself before moving USDC. |
| `ed25519_verify` host function | `policy` contract | 1Click's quote signature is checked on chain: no oracle, no trusted executor, no owner signature per payment. |
| Access keys as identity | console vault | A device asking to be admitted signs with its wallet key; a device that holds the vault checks `view_access_key_list` of the owner account and admits the account's own full-access keys by itself. |
| Sputnik DAO v2 / Trezu | `policy` contract | Human approval above a threshold, opened by the contract itself as a FunctionCall proposal; the callback stores the proposal id, `sync_dao_proposal` reads the verdict back. |
| NEP-141, NEP-297 events | `policy` contract | USDC in, every decision out as an event, so dashboards need no database. |
| Wallet sign-in (function-call key) | `web/login.html` | Any NEAR wallet through NEAR Connect adds a key limited to ten everyday methods of the company's contract (`add_order`, `add_recurring_order`, `close_order`, `approve_payment`, `cancel_payment`, `open_dao_proposal_for`, `sync_dao_proposal`, `sync_balance`, `set_vault`, `request_payment`): vendors and payouts, limits, the company record, pause, the withholding counters, operators, the DAO, withdrawals, ownership, roles and code changes are signed by the wallet itself. A stolen browser key can request, cover with an order and approve (with no DAO) payments to registered vendors within the caps and budgets, cancel what is held or queued, close orders, open DAO proposals and overwrite the vault; it cannot add a vendor, change a payout or a limit, or withdraw (the full list is in step 9). |

## Repository

```
README.md             this file: what it does, the runnable steps, the audits
WHITEPAPER.md         the principle, the architecture, the trust model, the economics
ROADMAP.md            what comes after the hackathon
contracts/policy      Rust, the policy contract (near-sdk 5), with unit tests
contracts/test-usdc   Rust, throwaway NEP-141 for testnet
contracts/registry    Rust, the public list of treasuries the explorer and the sign-in page read
app/src/agent.ts      inbox watcher (folder and Telegram approvals), PDF to PNG, NEAR AI call, claim submission
app/src/ai.ts         NEAR AI Cloud client: attestation preflight, structured extraction, signed receipt with exact bytes
app/src/verify.ts     independent receipt verification: signature, nonce, TDX quote binding, Intel collateral, chain
app/src/near.ts       near-api-js 7 helpers, meta transactions
app/src/relayer.ts    NEP-366 relayer, restricted to request_payment
app/src/executor.ts   NEAR Intents 1-Click routing for cross-chain vendors
app/src/quote.ts      the bytes 1Click signs for a quote, rebuilt so the contract can verify them
app/src/mcp.ts        MCP server, ten tools (submit_invoice, list_payments, get_payment, explain_decision, orders, vendors, treasury_status, verify_attestation, sync_dao_approvals, owner_cancel_payment)
app/src/setup.ts      one-shot environment setup
app/test/             vitest: receipt tampering, a real gateway receipt, offline parser, money parsing, the bytes of a 1Click quote
web/index.html        landing page: the three roles, the last decisions read live from the contract
web/login.html        sign in: any NEAR wallet via NEAR Connect (a treasury is created at first sign-in), an invite link, or a keys file
web/meteor.js         Meteor through its own SDK when the browser extension is on the page (the sandboxed connector cannot see it)
web/vendor/           the Meteor Connect SDK bundled as one ES module, with the script that rebuilds it
web/explorer.html     the network: every treasury from the registry, totals across companies, last decisions
web/docs.html         the documentation in one page
web/dashboard.html    one company's public dashboard, reads the contract over RPC
web/console.html      the console: PDF to PNG, enclave call, receipt checks, request_payment signed in the browser
web/app.html          the console's old address, redirects to console
web/privacy.html      the privacy notice for the Telegram relay
web/sw.js, web/manifest.webmanifest  the installable app: a network-first service worker and the manifest
web/csp.py            writes the Content-Security-Policy meta of console and login, run after editing them
web/style.css         shared styles (NEAR's palette: obsidian, paper, one signal green)
web/contracts/        the policy and registry wasm the console deploys, and builds.json with the known code hashes (plus the .js bundles for file:// use)
web/samples/          the sample PDFs and five recorded readings with their receipts
web/brand/            mark, favicon, lockup
relay/                Cloudflare Worker: the hosted reading relay (holds the NEAR AI key, forwards bytes untouched, daily caps), the Telegram inbox and the approvals from Telegram
invoices/             make_invoices.py and ten fictional sample invoices (the three small ones for the mainnet demo are in web/samples/mainnet/)
video/                the demo video, a Remotion project
CLAUDE.md, ARCHITECTURE.md, HANDOFF.md: notes for Claude Code, the architecture map, and the team's working log (translated from Italian)
```

## Where it sits next to NEAR Business

[NEAR Business](https://docs.business.near.com/what-is) is a multisig treasury: members, roles, a voting threshold, assets on many chains, confidential. It answers "who must approve this transfer". Bursar answers the question before it: "should this invoice be paid at all, and on what checks, without anyone reading it". The AI reads the invoice in an enclave; the contract applies the company's policy (registered vendor, fixed payout, caps, budgets, orders, duplicates, tax ids, withholding) and pays what passes; a person sees only what the rules hold back. The two fit together: Bursar already escalates held invoices to a Sputnik DAO, and a NEAR Business treasury could sit in the same place, as the vault that holds the funds and votes on the exceptions, while Bursar does the reading and the policy. Not built yet; the escalation hook is the same.

## Libraries, templates and AI-generated code

No template, starter kit or boilerplate: every file was written for this project. What it stands on:

| Where | Library | Role |
|---|---|---|
| `contracts/policy`, `contracts/registry` | near-sdk 5, schemars and bs58 (policy; ed25519-dalek in its tests) | the contracts |
| `contracts/test-usdc` | near-sdk 5, near-contract-standards 5 | the throwaway NEP-141 for testnet |
| `app/` | near-api-js 7, borsh | accounts, transactions, meta transactions |
| `app/` | @noble/curves, @noble/hashes, @scure/base | ed25519 and secp256k1 signatures, hashes, base58 and base64, in the verifier and the relayer |
| `app/` | @phala/dcap-qvl | Intel TDX quote verification against Intel collateral |
| `app/` | @defuse-protocol/one-click-sdk-typescript | NEAR Intents 1-Click quotes and status |
| `app/` | @modelcontextprotocol/sdk, zod | the MCP server and its tool schemas |
| `app/` (dev) | typescript, tsx, vitest, @types/node | build and tests |
| `web/` (CDN, pinned by version, with integrity hashes where the import map allows; the DCAP verifier `@phala/dcap-qvl` 0.7.0 is loaded from esm.sh by version only) | @fastnear/near-connect 0.14.1 | the wallet picker and the wallets' own code |
| `web/` | @noble/curves 2.4.0, @noble/hashes 2.4.0 | signing in the browser, receipt checks |
| `web/` | pdf.js 4.10.38 | PDF pages to PNG in the browser |
| `web/` | @phala/dcap-qvl 0.7.0 | the same quote verifier, in the browser |
| `web/` | SheetJS xlsx 0.18.5 | the Excel report (loaded on first use) |
| `web/` | qrcode-generator 1.4.4 | the treasury account as a QR code (loaded on first use) |
| `web/vendor/meteor-sdk.js` | @meteorwallet/sdk 3.24.0 bundled with esbuild | the Meteor browser extension path (the CDN builds do not load) |
| `relay/` | none (Cloudflare Workers runtime, KV) | the reading relay and the Telegram inbox |
| `invoices/` | reportlab (Python) | the fictional sample invoices |
| `video/` | remotion 4.0.538, react 19 | the demo video, not part of the product |
| tools | poppler (pdftoppm, pdftotext), near-cli-rs | rasterizing and text extraction, the CLI steps |

The invoice reading at runtime is a model on NEAR AI Cloud (`Qwen/Qwen3-VL-30B-A3B-Instruct` by default, `z-ai/glm-5.3-flash` as the fallback the agent and the console switch to when the gateway cannot reach the chosen one; the receipt names the model that actually answered; the recorded demo readings used `z-ai/glm-5.3-flash`), inside a TDX enclave, with the receipt and attestation described in step 6. The model only reads: it produces the claim, never a decision.

AI-generated code: the project was built by one person working with Claude Code (Anthropic) as the pair programmer for the whole codebase, contracts, tests, pages, relay, docs and this README included, under that person's direction and review, with the design decisions, the security rounds and the dry runs described above. Nothing was copied from another project. The three internal audit rounds were also run with Claude Code, as separate reviewer agents with no part in the code they read; they are not a third-party audit, and every contract finding has a unit test.

## Honest limits

- The Telegram inbox lives in Cloudflare KV, which is eventually consistent: an invoice posted in the same second the agent takes another one can be missed and must be posted again.
- A refused payment is stored small: the contract keeps the first 64 characters of its attestation reference and invoice hash, so a storm of bad claims cannot fill its storage. `bursar verify` matches a blocked payment on that prefix, and the console's exports show it as stored.
- Software, not a payment service. You run it on your own accounts with your own keys; nothing passes through us, except invoices read through the shared "Bursar reading" relay of the demo, and invoices received through the Telegram inbox, which the relay fetches from Telegram when you press Read. Paying vendors in a stablecoin is regulated differently from country to country (unrestricted, to be reported, or not allowed for businesses): checking that is the company's responsibility, not something Bursar can do.
- Structured e-invoices (SDI and FatturaPA in Italy, Peppol in Europe, Singapore and Australia, Factur-X, Verifactu, KSeF, CFDI in Mexico, NF-e in Brazil, India's GST e-invoice, Saudi Fatoora) are not parsed yet; the United States has no mandate and runs on PDFs: where they exist, the reading step can become a deterministic parser and the contract decides the same way. The demo reads PDFs.
- The offline parser (`--offline`) only understands the sample invoices. Real invoices need NEAR AI Cloud.
- Intents cross-chain payouts are mainnet only; the testnet demo stops at `Queued` for the Base vendor. Since 27 October 2026 1Click only quotes confidential swaps, and those need a partner key from `partners.near-intents.org` (Settings, NEAR Intents API key, or `ONE_CLICK_JWT` for the executor); without one every pair answers "Quoting for this pair is not available", which is what our mainnet treasury got on 2 November. The contract verifies 1Click's signature on every quote it settles; if 1Click rotates its signing key, the owner sets the new one with `set_quote_signer`.
- `bursar verify` checks the signature, the nonce, the quote's `report_data` binding and the quote against Intel collateral. It does not yet replay the RTMR3 event log against the quote (which images and compose file ran in the enclave) and does not check GPU evidence; the receipt keeps both, so it can be added without re-running anything.
- The verifier was tested against synthetic receipts, tampering and receipts from the live NEAR AI Cloud gateway (step 6 verifies one); the TDX quote is checked against Intel's collateral (certificate chain, TCB status), so that check needs the network.
- The "on chain" column and the links in the exports read the treasury's transactions from the nearblocks API v3 (v1 and v2 were retired on testnet on 5 November 2026, on mainnet at the end of November); when it is down they read `-`, and requests the CLI agent sent through the relayer, which are meta transactions to the agent's account, are not matched.

## License

MIT
