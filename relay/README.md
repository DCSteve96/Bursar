# Bursar reading relay

A Cloudflare Worker that holds one NEAR AI Cloud API key and forwards the three calls the web console makes to the enclave: the completion, the attestation report and the signature. It forwards the bytes untouched, so the enclave's signature over the exact request and response still verifies in the browser and in `bursar verify`. It holds no NEAR key and cannot move funds: it is the hosted "reading" half of Bursar, the part a company would pay for per invoice.

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
