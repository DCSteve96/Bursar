# Bursar reading relay

A Cloudflare Worker that holds one NEAR AI Cloud API key and forwards the three calls the web console makes to the enclave: the completion, the attestation report and the signature. It forwards the bytes untouched, so the enclave's signature over the exact request and response still verifies in the browser and in `bursar verify`. It holds no NEAR key and cannot move funds: it is the hosted "reading" half of Bursar, the part a company would pay for per invoice.

It also passes Intel collateral requests through to Phala's PCCS mirror (`/pccs/...`), so the browser can check the TDX quote's TCB status like the CLI does.

What it enforces: one allowed model, no streaming, a 2 MB body cap, an origin allowlist, and daily caps per address and in total (when a KV namespace is bound).

## Deploy

With wrangler:

```bash
cd relay
npx wrangler deploy
npx wrangler secret put NEAR_AI_API_KEY
# optional daily caps
npx wrangler kv namespace create LIMITS   # paste the id into wrangler.toml, redeploy
```

Without installing anything: in the Cloudflare dashboard create a Worker, paste `worker.js`, add the secret `NEAR_AI_API_KEY` and the variables from `wrangler.toml` under Settings. The Worker URL (for example `https://bursar-relay.<you>.workers.dev`) goes into the console's Settings as "AI relay", or into `RELAY_URL` in `web/app.html` as the default.

## Check

```bash
curl https://bursar-relay.<you>.workers.dev/
curl "https://bursar-relay.<you>.workers.dev/v1/attestation/report?model=z-ai/glm-5.3-flash&provider=near&signing_algo=ecdsa&nonce=$(openssl rand -hex 32)" | head -c 300
```

## Telegram inbox

The same Worker can receive invoices through a Telegram bot. A chat (a person, or a group with the vendor in it) is paired with a treasury from the console's Settings; every PDF posted in that chat shows up in the console's Inbox, where a person presses Read and the contract decides; the bot then tells the chat the decision. The Worker stores only the sender, the file name and Telegram's file reference in KV; the PDF stays on Telegram until it is read, and is never written anywhere by the Worker.

Setup, once:

1. In Telegram, talk to @BotFather: `/newbot`, pick a name and a username, copy the token.
2. Secrets on the Worker: `TELEGRAM_BOT_TOKEN` (the token) and `TELEGRAM_WEBHOOK_SECRET` (any long random string, for example `openssl rand -hex 24`). With wrangler: `npx wrangler secret put TELEGRAM_BOT_TOKEN`, same for the other. In the dashboard: Settings, Variables and Secrets.
3. A KV namespace bound as `INBOX`: `npx wrangler kv namespace create INBOX`, paste the id into `wrangler.toml`, redeploy. In the dashboard: Storage, KV, create one, then Settings, Bindings, add a KV binding named `INBOX`.
4. Tell Telegram where the Worker is: open `https://bursar-relay.<you>.workers.dev/tg/setup?secret=<TELEGRAM_WEBHOOK_SECRET>` in a browser once. See `{"ok":true,"webhook":"...","bot":"<username>"}`.

Then, in the console: Settings, "Connect a Telegram chat", open the link, press Start. Send a PDF to the chat. See it in Inbox.

A vendor never sees the console: generate a link for them in Settings and send it; they open it, press Start, and from then on send their invoices to the bot, which answers with the receipt and, later, the decision on that invoice only. For a group (you, the vendor, the bot): add the bot to the group and post `/start <code>` there. Bots in groups only see documents if privacy mode is off: in @BotFather, `/setprivacy`, pick the bot, Disable (or make the bot an admin of the group).

Routes: `POST /tg/webhook` (Telegram only, checked by the secret header), `GET /tg/setup`, `POST /inbox/pair` (with `vendor`, the vendor id the chat is for, and `for`, its name), `POST /inbox/chat` (change the vendor of a connected chat, or `remove` it), and with the treasury's inbox token as a Bearer header `GET /inbox/list`, `GET /inbox/file`, `POST /inbox/discard`, `POST /inbox/notify`. A company that brings its own NEAR AI Cloud key deploys this Worker on its own Cloudflare account, so nothing of its passes through Bursar.

