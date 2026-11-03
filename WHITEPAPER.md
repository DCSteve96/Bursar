# Bursar: an AI treasurer that pays invoices within limits it cannot change

Version 0.1, October 2026. Companion to the [README](README.md), which has the runnable steps, and the [roadmap](ROADMAP.md).

## Abstract

Companies pay invoices, and two things go wrong often enough to be an industry: a fake invoice gets paid (the "new bank details" fraud, the most common business scam in the world) and a real invoice gets paid twice. Letting an AI do the work makes both worse, unless the AI never holds the keys. Bursar separates the work into three roles that cannot take each other's place. An AI reads the invoice inside a trusted execution environment and says what it saw. A smart contract on NEAR, owned by the company, decides whether to pay, deterministically and within limits the AI cannot change. A plain program with no intelligence moves the money, and only to the payout the owner recorded. Every reading carries the enclave's signed receipt; every decision is an on-chain event. The funds never leave the company's own contract, with the company's own keys: Bursar is software, not a payment service.

## 1. The problem

Accounts payable is a flow of documents that end in a transfer. The dangerous moment is the one where a person, reading an invoice, decides where the money goes. Fraud attacks that moment: a convincing PDF with a changed account, a vendor's mailbox taken over, a second copy of a real invoice a month later. Automation attacks it too: an AI that reads invoices and holds a payment key is a very fast way to pay the wrong person.

The usual answers are controls around people: four eyes, approval chains, vendor master data, audits. They work and they are slow. The question Bursar asks is whether the controls can be written down once, enforced by a machine that cannot be persuaded, and still leave the reading to an AI, which is the part machines are now good at.

## 2. The principle

**The AI reads. The contract decides. A dumb executor moves the money.**

- The **agent** reads the invoice and produces a claim: vendor, invoice number, amount, due date, the payout printed on the document, the tax identifiers, the purchase order reference, and flags for anything odd. It holds one key, a NEAR function-call access key that can call exactly one method on one contract: `request_payment`. It cannot transfer, cannot change a vendor, cannot approve. A stolen agent key is worth nothing.
- The **policy contract** is the company's treasury. It holds the USDC, the vendor allowlist with each vendor's registered payout, the caps and budgets, the purchase orders, the roles. On every claim it decides: pay, hold for a person, or refuse. The decision is deterministic and reproducible from the chain alone.
- The **executor** settles the payments the contract queued for vendors on other chains. It is a plain process with no model in it. The contract gives it one place to send the USDC: the NEAR Intents deposit account the owner registered. A quote naming any other recipient is refused by the contract, not by the executor's good manners.

The AI never chooses an address. The contract pays NEAR vendors itself, in the same transaction that approved them. That single fact removes the fraud the industry fears most: a changed payout on an invoice is a block, not a payment.

## 3. Architecture

### 3.1 Accounts and keys

A company's deployment is a set of NEAR accounts under its own root: the treasury (the policy contract), the agent, the executor, and optionally a Sputnik DAO. The treasury account is created together with its contract in one transaction and never gets an access key: only the contract's own owner-gated methods can change it, including `upgrade`, which the contract performs on itself with a migration in the same batch. Nobody, not even the company's machine, holds a key that could redeploy or drain it.

The agent's only key is limited to `request_payment`. It sends claims as NEP-366 meta transactions through a relayer, so the agent account owns no NEAR for gas; the relayer verifies the delegate's signature, that the key is on the agent's account and the expiry before paying anything, and forwards nothing else.

The owner signs in from a browser with any NEAR wallet. The wallet adds a function-call key limited to the everyday methods of the company's contract; withdrawals, ownership, roles and code changes are signed by the wallet itself, each one shown to the owner before signing. Operators get on-chain roles (approve, manage vendors, manage orders) through invite links the owner can revoke.

### 3.2 Reading in an enclave

Invoices are sensitive: amounts, counterparties, bank details. The agent rasterizes the PDF and sends the pages to NEAR AI Cloud, where the model runs inside an Intel TDX trusted execution environment. Before each reading the agent fetches the enclave's attestation; the model's answer comes back as structured JSON with a receipt signed by the enclave over the exact request and response bytes. The receipt is verified by the agent before any claim is made on it, stored next to the payment, and referenced on chain by its hash.

Anyone can re-verify a reading later with `bursar verify`, without the API key and without trusting the agent: the signature over the exact bytes, the attestation nonce, the TDX quote's `report_data` binding, the quote against Intel's collateral, and the reference the contract stored. A one-byte change to the receipt fails the check.

A company can run its own reading relay (a small Cloudflare Worker that holds its NEAR AI key and forwards bytes untouched) or bring its own key; nothing of its invoices passes through Bursar.

### 3.3 The policy

The contract applies, in order, rules the owner wrote down:

1. The vendor is in the allowlist and active.
2. The payout printed on the invoice equals the payout the owner recorded. Otherwise the payment is blocked with reason `payout_changed`.
3. The invoice is not a duplicate: not the same normalized number for that vendor, not the same file hash.
4. The tax identifiers on the invoice match the vendor's and the company's, where recorded. Names can be imitated; tax ids cannot.
5. The amount is within the per-payment cap, the vendor's monthly budget and the daily cap, and the treasury can cover it.
6. A purchase order or a standing order covers the invoice. An invoice outside them, or larger than its order, is held for a person.
7. At or above the approval threshold, or when the model flagged something, or after a vendor's daily allowance of autopaid invoices, a person decides: the owner or an approver in the console, or a Sputnik DAO council through a proposal the contract opens itself. The contract writes the proposal id on the payment and reads the verdict back; a rejected or expired proposal cancels it.
8. Withholding tax, set per vendor by the accountant, is kept back and set aside for the state, outside the spendable balance.

What passes is paid at once if the vendor is on NEAR, or queued for the executor if the vendor is on Base, Arbitrum, Solana or Sui. What is held waits. What fails is refused with a reason. All three outcomes are events, so dashboards and auditors need no database.

Every payment carries the payout it was checked against and goes nowhere else. A payout recorded or changed by an operator pays nothing until the owner confirms it. Pausing the treasury or switching a vendor off is re-checked at approval time, not only at request time.

### 3.4 Cross-chain settlement

For a vendor on another chain the executor asks NEAR Intents for a quote on exactly the net amount the contract will send, with the vendor's recorded address as recipient, and calls `settle` with the bytes 1Click signed and its signature. The contract verifies the signature against 1Click's key, checks that the quote pays the vendor's recorded address for exactly the net amount in USDC on the vendor's chain, that the swap keeps at least 98 percent of it and that it has not expired, then registers the one-off deposit account on the token and moves the USDC there, in one receipt. The executor names no destination and the owner signs nothing per payment. The executor then watches the settlement and marks it settled with the destination transaction hash. A refunded settlement goes back in front of a person rather than being re-sent on the executor's own; one nobody can confirm is closed by the owner, delivered or not.

### 3.5 Inboxes and approvals

Invoices reach the treasury by file drop, by a Telegram bot, or through an MCP server that lets any AI assistant submit, list and explain payments with exactly the agent's powers. On Telegram each vendor has its own chat bound to one treasury and, optionally, to one vendor id: an invoice from that chat naming another vendor is flagged and held. The owner's approvers get every invoice with Approve and Reject on the phone; a hold comes back to them with its reason and a link to the console, where the exceptions are decided with the wallet. Trusted vendors can be accepted without a question; the contract still decides. No key ever sits on a server: the relay holds a reading key and the inbox, nothing that can move money.

## 4. Trust and threat model

What Bursar trusts, and why it is acceptable:

- **The enclave** for the confidentiality of the invoice and the integrity of the reading. The trust is checkable: attestation before every reading, a signed receipt after, independent verification by anyone. A wrong reading can still happen; it meets the policy, which cannot be persuaded.
- **The contract** for the decision. It is public, small, unit-tested rule by rule (67 tests), and audited in three independent rounds with every finding reproduced by a test before its fix. Its builds are listed with their hashes, and the explorer and the sign-in page verify a treasury's code hash against that list.
- **The owner's wallet** for the sensitive methods. Ownership moves in two steps, an offer by the owner and an acceptance by the new owner, so a wallet talked into one signature gives nothing away.
- **The executor** for nothing but timing: it brings a quote 1Click signed, and the contract checks the quote's recipient, amount, asset and expiry itself.

What Bursar does not trust: the agent (one method, no NEAR, no addresses), the relayer (verifies before paying gas, rate-limited), the Telegram relay (no keys, bound chats, signed pairing by the owner), the browser (secrets in a vault encrypted with a key only the owner's wallet can derive, stored on the contract), the registry (a hint, verified against the contract by every reader), the model's flags and tax ids (they can only add scrutiny, never remove a block).

The bounds that hold whatever the AI does: the per-payment cap, the daily cap, the vendor budgets, the allowlist and the registered payouts. A fully compromised agent can, at worst, submit claims that meet those bounds, and the quotas on requests, refusals and holds limit even that.

## 5. Privacy

The invoice is read in an enclave and never leaves it in clear text; the agent keeps the pages only for the time of the reading. On chain the contract stores the claim, not the document: vendor id, normalized invoice number, amount, due date, a hash of the file, the payout seen, flags, and the receipt reference. Companies with a reading relay of their own keep their NEAR AI key and their traffic to themselves. The public explorer shows what a company chose to make public: its treasury's decisions, which are events the contract emits anyway.

## 6. Economics

Bursar is software. It never takes a percentage of payments, it never holds funds, and it is not a payment service: companies run it on their own accounts, with their own keys, and are responsible for the rules that apply to paying vendors in a stablecoin where they are.

The unit that scales is the invoice, and its marginal cost is cents of enclave time, so the plans are per treasury and by volume: a self-hosted license, a pay-as-you-go rate per invoice, and monthly plans from a starter for small companies to business and enterprise plans with roles, DAO approvals, forecasts, exports, connectors and dedicated relays. The subscription itself is paid by the treasury: Bursar is a registered vendor with a standing order in USDC, invoices through the same bot, and is paid by the contract within the customer's own limits. No cards, no direct debits.

## 7. Where it sits

[NEAR Business](https://docs.business.near.com/what-is) is a multisig treasury: members, roles, a voting threshold, assets on many chains. It answers "who must approve this transfer". Bursar answers the question before it: "should this invoice be paid at all, and on what checks, without anyone reading it". The two fit together, and the roadmap puts NEAR Business behind a Bursar treasury as the vault that holds the funds and votes on the exceptions. Generic policy engines for agents in enclaves exist; Bursar is a product for invoices, with the vendor record, the orders, the tax ids and the withholding that accounts payable actually has.

## 8. What exists today

The policy contract (Rust, near-sdk 5, 67 unit tests, three audit rounds), the registry of treasuries, the agent, relayer, executor and MCP server (TypeScript), the web console (wallet sign-in, roles, DAO, encrypted vault, analytics, reports, contract upgrades from the browser), the public explorer and dashboards, the Telegram inbox with approvals from the phone and trusted vendors, independent receipt verification, and a load test of 1,030 invoices from ten invented companies. Live on NEAR testnet; cross-chain settlement through NEAR Intents on mainnet. The README has the step for each.

## 9. Limits

Structured e-invoices are not parsed yet; the demo reads PDFs. Intents settlement is mainnet only. The verifier does not yet replay the enclave's event log or check GPU evidence, though the receipt keeps both. Cloudflare KV behind the Telegram inbox is eventually consistent. Each of these is on the roadmap or stated in the README's honest limits, which is where they stay until they are gone.
