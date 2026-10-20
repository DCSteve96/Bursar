# Bursar: stato del progetto e decisioni (handoff del 20 ottobre 2026, aggiornato nella sessione cloud dello stesso giorno)

Questo file passa a Claude Code tutto quello che è stato deciso e verificato in chat. Non è per i giudici. Quando una cosa qui cambia, aggiorna questo file.

## 1. Il progetto in una pagina

Problema: le aziende pagano fatture false (frode del "nuovo IBAN", la truffa aziendale più diffusa) e fatture doppie. Un'AI che paga le fatture peggiora entrambe le cose, a meno che non abbia mai le chiavi.

Soluzione: l'agente legge la fattura in un TEE e chiede al contratto di pagare con una sola chiave limitata a `request_payment`, senza possedere NEAR (meta transaction). Il contratto decide: fornitore in allowlist, payout sulla fattura uguale a quello registrato dal proprietario, niente duplicati, tetti per pagamento, mensili per fornitore e giornalieri, approvazione DAO sopra soglia. Paga su NEAR nella stessa transazione, oppure mette in coda per l'executor che usa NEAR Intents verso la chain del fornitore (il contratto verifica che il destinatario sia quello registrato). Tutto è evento on chain; nessun database.

Tracce: `realworld` (principale), `business`, `privacy`, `security`. Nome: Bursar (da confermare, deve essere unico nell'hackathon).

## 2. Cosa è fatto e verificato su testnet (20 ottobre)

Ambiente usa e getta creato da account di faucet, da non riusare: root `bursar-mvgent6v.testnet`, treasury `treasury.bursar-mvgent6v.testnet`, agent, executor, tusdc, DAO `bursar-bursar-mvgent6v.sputnik-v2.testnet`. Stefano rifarà il setup con un account suo.

Verificato on chain:
- `setup` crea tutto da un comando (account, tUSDC, DAO Sputnik, contratto, fornitori, fondi, chiave limitata dell'agente).
- Fattura 1 (Acme, 480, NEAR): **Paid**, il fornitore ha ricevuto 480 tUSDC.
- Fattura 2 (DesignCo, 1.250, Base): **Queued**.
- Fattura 3 (Legal Partners, 9.800, NEAR): **Approval**; il contratto ha aperto la proposta Sputnik (FunctionCall verso `approve_payment`); votata da council con `act_proposal {id, action: "VoteApprove"}`; la DAO ha richiamato il contratto; stato **Paid**, fornitore pagato.
- Fattura 4 (Acme con "nuovo wallet"): **Blocked payout_changed**.
- Fattura 1 rimandata: **Blocked duplicate_invoice**.
- Meta transaction: l'agente firma con la function-call key, il relayer (account executor) paga il gas, il contratto vede `predecessor == agent`. Il relayer rifiuta qualsiasi cosa che non sia `request_payment` dall'agente.
- L'account agente ha una sola chiave: FunctionCall, `receiver_id` = treasury, `method_names` = `["request_payment"]`, allowance 0,05 NEAR.
- 7 unit test Rust verdi.

Non ancora provato con chiavi vere: NEAR AI Cloud (`ai.ts` è scritto sulle docs), Intents (solo mainnet), Trezu (solo mainnet).

### 2.1 Fatto nella sessione cloud del 20 ottobre (solo offline: la rete del container bloccava RPC NEAR, NEAR AI e Intents)

- Contratto: callback su `add_proposal` che salva `dao_proposal_id` (evento `dao_proposal_opened`) e, se la DAO rifiuta di aprire la proposta, blocca il pagamento con `dao_proposal_failed` e libera il budget. Nuovo metodo `sync_dao_proposal(id)` (chiunque può chiamarlo): legge `get_proposal` dalla DAO e, solo sulla risposta della DAO (`Rejected`, `Expired`, `Removed`, `Failed`, `Moved`), cancella il pagamento con motivo `dao_<stato>`. Callback `on_ft_transfer` su ogni `ft_transfer`: se fallisce, il saldo torna indietro (`Paid` -> `Blocked transfer_failed`, `Settling` -> `Queued`, withdraw ripristinato). 11 unit test. Firme pubbliche invariate (nessuna modifica a `near.ts`), solo metodi nuovi.
- Wasm: `strip = true` nel profilo release porta il wasm da 502 KB (con i callback) a 303 KB; con `wasm-opt -Oz` 249 KB. `contracts/policy/build.sh` applica wasm-opt se presente. Il contratto va rideployato (le strutture di stato non sono cambiate, `Payment.dao_proposal_id` esisteva già).
- `ai.ts` non usa più l'SDK OpenAI: chiama l'API con `fetch` e conserva i byte esatti di richiesta e risposta, perché il gateway firma `<model>:<sha256(req)>:<sha256(res)>` sui byte, e una riserializzazione rompeva la firma. Il receipt in `.bursar/receipts/<id>.json` contiene tutto: byte, firma, report di attestazione con quote TDX, nonce.
- `verify.ts` e `bursar verify <id>`: verifica indipendente senza API key. Controlli: hash dei byte, testo firmato, recupero ECDSA (EIP-191, come `ethers.verifyMessage`), `signature_kind == provider_tee`, report con lo stesso signer e il nostro nonce, `report_data` del quote TDX (signer nei byte 0..20, nonce nei byte 32..64), quote verificato contro il collateral Intel con `@phala/dcap-qvl` (rete necessaria, `--no-collateral` per saltare), estrazione identica all'output del modello, `attestation_ref` on chain. Formati presi dal sorgente di `@nearai/inference-sdk` 0.1.0 (che richiede Node 24, per questo non lo usiamo). Non fa ancora il replay dell'event log su RTMR3 né la verifica GPU.
- Test app con vitest (`npm test`): recupero firma su vettore noto, receipt manomesso (risposta modificata, firma di un'altra chiave, nonce diverso, firma del gateway), parser offline sulle 4 fatture.
- `bursar sync` e tool MCP `sync_dao_approvals`, `verify_attestation`; l'executor chiama `syncApprovals` a ogni tick e salta Intents fuori da mainnet.
- Dashboard statica `web/index.html`: legge il contratto via RPC, nessun build.
- README aggiornato con i passi "do X, see Y" per verify, sync, dashboard, test. Gli output di esempio di `verify` sono il formato del comando, non un run reale: va rifatto con un receipt vero.

### 2.2 Rifatto su testnet con il contratto nuovo (20 ottobre, seconda parte della sessione cloud, dopo l'apertura della rete)

Nuovo ambiente usa e getta da faucet (chiavi generate nel container, non di Stefano): root `bursar-itlecew5.testnet`, treasury `treasury.bursar-itlecew5.testnet`, DAO `bursar-bursar-itlecew5.sputnik-v2.testnet`, tUSDC `tusdc.bursar-itlecew5.testnet`; account di appoggio `bursar-fund-bfsz0u.testnet` (svuotato) e `probe-x.testnet` (creato per sbaglio con una chiave inutile, da ignorare). Il README punta a questo ambiente.

Verificato on chain, tutto dal README:
- `setup` da zero: ok, contratto nuovo (303 KB) deployato.
- Fatture 1-4 via relayer: Paid, Queued, Approval con `dao#0` scritto dal callback, Blocked payout_changed. Fattura 1 rimandata: Blocked duplicate_invoice (#5).
- `VoteApprove` su proposta 0: #3 Paid, legalpartners riceve 9.800 tUSDC.
- Seconda fattura sopra soglia (LP-2211, 3.000, inviata via relayer): #6 Approval `dao#1`; `sync_dao_proposal` con proposta aperta risponde `InProgress` e non cambia nulla; dopo `VoteReject` risponde `Rejected` e il pagamento va in `Cancelled dao_rejected`, `spent_this_month` di legalpartners torna a 9.800 (i 3.000 liberati). Tx `2AuGZHE8kpN3rhFd12j9hQsLyGSvQ36twHra5y29G3BX`.
- Fornitore con account inesistente (`ghost.`): #7 Paid poi callback -> `Blocked transfer_failed`, saldo identico a prima (4.720). Tx `3zhTdupXKtXueQFkj1mNjFmG5kEMgCVEiGGYbuxD38E7`.
- Dashboard `web/index.html` caricata in Chromium headless contro il contratto vero: mostra i 7 pagamenti con i motivi.
- `verify 1` su un receipt offline fallisce alla prima riga, come deve.
- La chiave dell'agente (allowance 0,05 NEAR) non basta per una chiamata diretta da 150 TGas: `--direct` serve solo se l'agente ha NEAR suo. Via relayer tutto ok.

Intents 1-Click (mainnet, solo quote `dry`, nessun deposito): gli asset id USDC in `config.ts` sono tutti presenti in `/v0/tokens`. Quote EXACT_OUTPUT 1.250 USDC NEAR -> Base: amountIn 1.256,53 USDC (0,52% senza JWT), 22 secondi stimati. Due cose imparate: `refundTo` deve essere un account NEAR esistente (altrimenti "Internal server error"), e `recipient` EVM deve essere tutto minuscolo o con checksum EIP-55 valido: il placeholder `0x4F1aC0dE...` aveva un checksum sbagliato ("recipient is not valid"). Ora il placeholder è minuscolo in `setup.ts` e `make_invoices.py`, e il contratto confronta gli indirizzi chain senza distinguere maiuscole (`Payout::same_as`), così una fattura che stampa lo stesso indirizzo con un case diverso non finisce in `payout_changed`.

NEAR AI Cloud: `/v1/models` conferma `z-ai/glm-5.3-flash`, `Qwen/Qwen3-VL-30B-A3B-Instruct`, `Qwen/Qwen3.8-27B`; `/v1/attestation/report` richiede la chiave (401). Il test con chiave vera resta da fare.

Rete e RPC: `rpc.testnet.near.org` risponde 429 (rate limit) e `rpc.mainnet.near.org` pure; i default ora sono FastNEAR (`test.rpc.fastnear.com`, `free.rpc.fastnear.com`), override con `NEAR_RPC`. Nelle sessioni cloud Node deve avere `NODE_USE_ENV_PROXY=1` perché `fetch` passi dal proxy del container (il faucet `helper.nearprotocol.com` si chiama con `POST /account {newAccountId, newAccountPublicKey}`, 10 NEAR per account).

Da fare con chiavi: `verify` su un receipt vero (primo punto in cui il formato dell'API può smentire il codice).

## 3. Decisioni prese

- Separato da Epoch, sempre. Niente brand, niente Sui.
- Non custodial e self-hosted, per restare fuori da MiCA. L'executor è l'unica chiave che muove fondi ed è limitato dal contratto ai payout registrati. Nel README: "software, not a payment service".
- Solo USDC. Fatture finte.
- Demo finale su mainnet con pochi USDC veri (Intents e Trezu non esistono su testnet); sviluppo e README su testnet.
- Nessun database: la chain è lo stato, la dashboard legge l'RPC.
- Data: Stefano chiede nel Discord di NEAR se il lavoro preparatorio è ammesso. In mancanza di risposta, la repo pubblica parte dal 1° novembre con history pulita; quanto fatto prima è un prototipo privato.
- Monetizzazione (futura, non per l'hackathon): fee in bps nel contratto, `appFees` di Intents (già previsto nel codice con `referral: "bursar"`), abbonamento per la parte hostata (lettura, relayer, export), grant NEAR. Non servizio di pagamento.
- Parte hostata, confine da tenere (ragionamento del 20 ottobre, da confermare con Stefano): si può ospitare l'agente (chiave limitata a `request_payment`, nessun potere di spesa), il relayer (paga solo gas, un account nostro), monitoraggio, notifiche, export, connettori. Non va ospitata la chiave dell'executor con potere di `settle`: anche se il contratto vincola il destinatario, è l'unica chiave che fa uscire USDC e tenerla noi assomiglia a custodia. Se un giorno serve, la chiave dell'executor diventa una function-call key limitata a `settle` e `mark_settled` sul contratto dell'azienda (il contratto già controlla il destinatario), e resta comunque nelle mani dell'azienda. Non è un parere legale.

## 4. Regole dell'hackathon (da HACKATHON.md, rileggerlo prima della submission)

- Costruzione 1-14 novembre 2026, UTC. Repo pubblica entro 2026-11-14T23:59Z. Giudizio 16-18, risultati entro il 18.
- Premi: grand prize 55k, 13 primi da 10k, 13 secondi da 3k, 13 terzi da 2k, in NEAR. Una submission per team, non modificabile, più tracce ammesse.
- Serve: repo pubblica, post demo su X (video o screenshot, dire che è costruito al NEAR HACKATHON), form con nome progetto (unico), lead, email (unica), team size (`1`), tracce (`["realworld","business","privacy","security"]`), account NEAR mainnet per il premio, descrizione 20-2000 caratteri, consenso.
- API: `POST https://nearhackathon.com/api/applications` con `requestId` UUID generato una volta e riusato nei retry. Il campo `website` è una trappola anti-spam: non inviarlo. Submission solo nella finestra (fuori risponde 403).
- Giudici umani: Illia Polosukhin, Mert Mumtaz (Helius), Eddy Lazzarin (a16z crypto), Avichal Garg (Electric Capital), Kain Warwick, Haseeb Qureshi (Dragonfly), Stepan Gershuni. Giudici AI: Claude Code e Codex. README per macchina e umano, passi "do X, see Y", niente marketing.
- Partner con docs: NEAR Intents, Aurora, HOT, Rhea, meme.cooking, HEX, NEAR.AI, SVRN, Trezu, SputnikDAO, OutLayer, GoMining. OutLayer fa già custodia per agenti in TEE: non competere con loro su "policy engine generico", Bursar è un prodotto per le fatture.

## 5. API verificate (fonte: docs ufficiali, 19-20 ottobre)

### NEAR AI Cloud
- Firma della risposta (verificato nel sorgente dell'SDK 0.1.0): `text` = `<model id canonico dalla richiesta>:<sha256 hex dei byte della richiesta>:<sha256 hex dei byte della risposta>`; `signature` ECDSA 65 byte, verificata con `ethers.verifyMessage` (EIP-191) e confrontata con `signing_address` (20 byte). `signature_kind` `provider_tee` = firmato nel TEE del modello; `gateway` = firmato dal gateway (quando riscrive la risposta), non prova l'esecuzione nel TEE del modello. `GET /v1/attestation/report` risponde `{ model_attestations: [ { request_nonce, signing_algo, signing_address, intel_quote (hex), event_log, info, nvidia_payload?, report_data? } ] }`; nel quote TDX `report_data` = signer (20 byte, zero-padded a 32) + nonce (32 byte). Le firme restano sul gateway 60 minuti: `fetchSignature` va chiamato subito dopo la completion, come fa `ai.ts`.
- Base URL `https://cloud-api.near.ai/v1`, compatibile OpenAI. Chiave da cloud.near.ai (crediti prepagati, spend limit per chiave).
- Modelli in TEE con visione: `z-ai/glm-5.3-flash` (scelto, structured outputs, 1M ctx, economico), `Qwen/Qwen3.8-27B`, `Qwen/Qwen3-VL-30B-A3B-Instruct`. Niente PDF in input: rasterizzare con `pdftoppm` e mandare PNG base64 in `image_url`.
- Attestazione: `GET /v1/attestation/report?model=<id>&provider=near&signing_algo=ecdsa&nonce=<32 byte hex>` con header `x-no-aliasing: true`, da chiamare prima della completion. Firma della risposta: `GET /v1/signature/<completion id>?signing_algo=ecdsa` restituisce `text`, `signature`, `signing_address`, `signature_kind` (`provider_tee` = `<model>:<sha256(req)>:<sha256(res)>`). Usare richieste non streaming con l'id canonico del modello. SDK alternativo: `@nearai/inference-sdk` (Node 24+).
- `ai.ts` salva `inference_id`, hash di richiesta e risposta, nonce, `signing_address` e mette un riferimento compatto in `attestation_ref` del pagamento.

### NEAR Intents 1-Click
- Base `https://1click.chaindefuser.com`, `POST /v0/quote`, `POST /v0/deposit/submit`, `GET /v0/status?depositAddress=`. JWT partner da partners.near-intents.org in `X-API-Key` (facoltativo; senza, +25 bps; con, 1 bp sulle coppie stablecoin).
- **Nessuna testnet.** Mainnet con account di test e importi piccoli. `dry: true` per validare senza depositare.
- USDC asset id: NEAR `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`; Base `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`; Arbitrum `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near`; Solana `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`; Sui `nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near`.
- Flusso: quote con `swapType: EXACT_OUTPUT`, `depositType: ORIGIN_CHAIN`, `recipientType: DESTINATION_CHAIN`, `recipient` = indirizzo del fornitore, `refundTo` = treasury. Il `depositAddress` è un account implicito NEAR: il contratto fa `ft_transfer` di USDC verso di esso. Verificare su mainnet se serve `storage_deposit` per il deposit address. Minimi: Base 0,15 USDC. Tempi: 2 minuti tipici, fino a 15.
- SDK `@defuse-protocol/one-click-sdk-typescript` (usato in `executor.ts`).

### NEAR, chiavi, meta transaction
- near-api-js 7.3.1: `new Account(id, provider, KeyPairSigner)`, `createSignedMetaTransaction`, `encodeSignedDelegate`, `relayMetaTransaction`, `addFunctionCallAccessKey`, `createSubAccount`, `callFunction` / `callFunctionRaw`. Nel relayer il delegate si decodifica con `borsh.deserialize(SCHEMA.SignedDelegate, bytes)`.
- Le function-call key non possono allegare deposito: per questo `add_proposal` sulla DAO lo fa il contratto, non l'agente.
- Rust: near-sdk 5.29.1. Il macro `impl_fungible_token_storage!` di near-contract-standards 5.29.1 non compila (U128 vs NearToken): in `test-usdc` StorageManagement è implementato a mano.
- `cargo near` non era installabile nell'ambiente di prova; il wasm si compila con `cargo build --release --target wasm32-unknown-unknown`. Sul Mac `cargo install cargo-near` dovrebbe funzionare e dà anche l'ABI.

### Sputnik DAO v2 / Trezu
- Factory testnet `sputnik-v2.testnet`: `create {name, args: base64({config:{name,purpose,metadata}, policy:[council...]})}` con 6 NEAR. Bond proposta 1 NEAR (il contratto lo tiene in `dao_bond`, modificabile con `set_roles`). Il treasury deve avere NEAR per i bond.
- Proposta dal contratto: `add_proposal {proposal: {description, kind: {FunctionCall: {receiver_id, actions: [{method_name, args: base64, deposit: "0", gas: "50000000000000"}]}}}}`. Approvazione: `act_proposal {id, action: "VoteApprove"}` (300 TGas). Versione testnet 2.0.0; dal main più recente serve anche il campo `proposal` in `act_proposal`.
- Trezu (trezu.app) è la UI su Sputnik v2, **solo mainnet**; factory mainnet `sputnik-dao.near`.

## 6. Cosa resta (ordine consigliato)

1. **Setup con account di Stefano** su testnet: fatto con un account usa e getta (2.2), da ripetere con il suo solo se vuole che il README punti a un account suo.
2. **NEAR AI Cloud con chiave vera**: `npm run agent -- --once` senza `--offline` sulle 4 fatture; sistemare il prompt finché l'estrazione è giusta; poi `npm run dev verify <id>` su un receipt vero e correggere `verify.ts` se il formato reale differisce. Se un check fallisce per un motivo di formato va capito, non allentato.
3. **Mainnet**: `setup --root <account>.near --mainnet` (usa USDC vero `17208628...`, niente faucet; serve storage_deposit del treasury sul contratto USDC, da aggiungere a setup se manca), fondi: 50-100 USDC e circa 12 NEAR. Un indirizzo Base di Stefano come fornitore "DesignCo". Provare l'executor: quote, `settle`, `mark_settled`. Proposta sopra soglia vista e approvata in Trezu.
4. **Contratto** (fatto il 20 ottobre: `dao_proposal_id`, cancel su rifiuto DAO, rollback dei transfer, wasm 303 KB). Resta: replay RTMR3 nel verifier, eventuale `storage_deposit` automatico per i fornitori NEAR.
5. **Dashboard** statica fatta (`web/index.html`); da provare su un contratto vero e, se piace, pubblicare su GitHub Pages.
6. **Video demo** (2-3 minuti): le 4 fatture, l'approvazione in Trezu, il pagamento su Base, il blocco della frode, l'MCP da Claude. Post su X.
7. **README finale** con indirizzi mainnet, e **submission** via form o API dopo conferma del payload.

## 7. Cosa serve da Stefano

- Account NEAR mainnet per il premio e account testnet suo.
- Chiave NEAR AI Cloud con un piccolo top-up.
- Conferma del nome.
- Risposta del Discord NEAR sul lavoro preparatorio (o decisione di ripartire dal 1° novembre).
- Account X da cui pubblicare il post demo (nuovo, separato da Epoch).
- Per le sessioni cloud di Claude Code: nelle impostazioni dell'ambiente, rete con dominii consentiti `rpc.testnet.near.org`, `rpc.mainnet.near.org`, `helper.nearprotocol.com`, `cloud-api.near.ai`, `1click.chaindefuser.com`, `pccs.phala.network` (collateral Intel per `verify`), `docs.near.ai`; e `NEAR_AI_API_KEY` come variabile d'ambiente segreta, mai in chat.
