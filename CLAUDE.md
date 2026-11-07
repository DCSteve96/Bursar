# Bursar: notes for Claude Code

Read this file first, then `README.md` (what the project is and how to try it, written for judges and users) and `ARCHITECTURE.md` (how the pieces fit). `HANDOFF.md` is the team's working log: long, chronological, useful when you need to know why something is the way it is.

## What it is

Bursar is an AI treasurer for companies of any size. It reads invoice PDFs inside a trusted execution environment (NEAR AI Cloud), asks a NEAR contract to pay them, and the contract decides within limits the AI cannot change. Built for the NEAR HACKATHON (1 to 14 November 2026). Tracks: `realworld`, `business`, `privacy`, `security`.

The sentence that must never get lost: **The AI reads. The contract decides. A dumb executor moves the money.**

## Fixed rules

1. **Non custodial.** The funds sit in the company's own contract, under the company's keys. The AI never chooses an address. The executor can only settle on a quote 1Click signed for the vendor's recorded payout, and the contract verifies it. Nothing may turn Bursar into a payment service or a custodian: the README keeps the sentence "software, not a payment service".
2. **USDC only** in examples and texts.
3. **Fictional invoices only.** No real person or company in the sample PDFs, the video or the tests.
4. **No secrets in the repository.** Keys live in `~/.near-credentials` or in environment variables; `.env.*` is in `.gitignore`. A key pasted into a chat is compromised: rotate it.
5. **No mainnet without the maintainer's explicit confirmation**, and no transaction signed with the maintainer's keys unless asked for that specific action.
6. **Git:** commit and push only when the maintainer has authorised it in this repository. Commit messages in English, short, present tense.
7. **International market, companies of every size.** Texts, examples, placeholders and roadmap speak to companies everywhere; country-specific features (withholding tax, e-invoicing) stay configurable and secondary.
8. **One submission, never resent.** The hackathon application is posted once, only after the maintainer has confirmed the full payload printed on screen.

## Writing style

- No em dashes, no emoji.
- Texts for judges and the public are in English. Concise, honest, direct; no empty reassurance.
- Every claim in the README, the white paper, the docs page and the console must match the code. When the code changes, the texts change in the same commit.

## Layout

```
contracts/policy      the policy contract, Rust, near-sdk 5 (67 unit tests); build-hashes.py writes web/contracts/builds.json and the .js bundles, run it after every wasm build
contracts/test-usdc   a throwaway NEP-141 for testnet, with open mint
contracts/registry    the public registry of treasuries the explorer and the login page read (7 unit tests)
app/src/              TypeScript, near-api-js 7
  config.ts           all configuration from env; USDC asset ids per chain (Intents)
  near.ts             NEAR helpers, meta transactions (NEP-366)
  ai.ts               NEAR AI Cloud: attestation first, JSON extraction, signed receipt; offline parser for the sample PDFs
  agent.ts            inbox watcher (folder and Telegram approvals via the relay), PDF to PNG (pdftoppm) and text (pdftotext), claim to request_payment
  relayer.ts          NEP-366 relayer that accepts only request_payment from the agent
  executor.ts         NEAR Intents 1-Click for vendors on other chains (mainnet only)
  quote.ts            the bytes 1Click signs for a quote, rebuilt so the contract can verify them
  mcp.ts              MCP server (ten tools)
  setup.ts            creates accounts, deploys, funds, adds vendors, creates the DAO, leaves the agent one key
  cli.ts              bursar setup|agent|submit|read|executor|relayer|mcp|status|verify|sync
web/                  index.html (landing), login.html (wallet, invite, keys), explorer.html (the network), docs.html, dashboard.html (one treasury), console.html (the console), meteor.js, vendor/, style.css, brand/, samples/, contracts/
relay/                Cloudflare Worker: reading relay (holds the NEAR AI key, forwards the bytes untouched, daily caps), Telegram inbox and approvals
invoices/             make_invoices.py and the sample PDFs
video/                the demo video, a Remotion project
```

## Commands

```bash
# contracts
(cd contracts/policy && cargo test && ./build.sh)
(cd contracts/test-usdc && cargo build --release --target wasm32-unknown-unknown)
(cd contracts/registry && cargo test && ./build.sh)
# app
cd app && npm install && npx tsc -p . --noEmit && npm test
npx tsx src/cli.ts setup --root <account>.testnet
set -a; source .env.testnet; set +a
npm run relayer &
npm run agent -- --once --offline
npm run dev status
```

Prerequisites: Rust stable with the `wasm32-unknown-unknown` target, Node 22+, poppler (`pdftoppm`, `pdftotext`), Python 3 with `reportlab` (the sample invoices).

## How to work

- Before changing the contract: `cargo test`. After: rebuild the wasm, run `build-hashes.py`, and if a method's signature changed update `near.ts`, `mcp.ts`, the console and the README.
- Testnet is where everything is tried, except NEAR Intents and Trezu (mainnet only; the console's `?intents=stub` stands in for 1Click on testnet).
- Every new feature gets a "do X, see Y" step in the README: AI judges execute the README.
- Keep the wasm small: the contract's storage costs NEAR, and `upgrade` must fit in the gas reserve (60 TGas).
- Re-read `https://nearhackathon.com/HACKATHON.md` before submitting: the rules can change.
