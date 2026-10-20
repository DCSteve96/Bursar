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

### 2.3 Sessione cloud del 20 ottobre, terza parte: tentativo con NEAR AI Cloud

- La sessione aveva una credenziale per `cloud-api.near.ai` iniettata dal proxy dell'ambiente (connettore "Consenti + inietta"), non `NEAR_AI_API_KEY`. Ogni richiesta a `/v1/chat/completions` e `/v1/attestation/report` risponde `401 {"message":"Missing authorization header"}` con l'header `X-Proxy-Error: upstream auth failed`: il proxy prova a iniettare ma la credenziale non arriva come `Authorization: Bearer <chiave>`. `/v1/models` risponde 200 perché è pubblico. Da sistemare nelle impostazioni dell'ambiente: o la credenziale del connettore come header `Authorization` con valore `Bearer <chiave>`, o più semplicemente `NEAR_AI_API_KEY` come variabile d'ambiente segreta (vedi punto 7). Il test con chiave vera resta da fare.
- Nuovo comando `bursar read <file.pdf> [--offline] [--no-collateral]`: legge una fattura nel TEE, scrive `.bursar/receipts/read-<nome>.json` (stesso formato dei receipt dell'agente, con `payment` e `tx` nulli) e lancia subito `verifyReceipt` senza il check on chain. Serve a provare NEAR AI Cloud senza treasury, relayer o account NEAR: è il primo comando da lanciare appena la chiave funziona, sulle 4 fatture, prima di `agent --once`. Nel README è alla fine del passo 6. `agent.ts` ora ha `readInvoiceFile` (lettura) separato da `processInvoice` (lettura + `request_payment`); la logica del claim è in `buildClaim`, invariata.
- `NEAR_AI_API_KEY=proxy`: `ai.ts` non manda l'header `Authorization` e lascia che sia il proxy dell'ambiente ad aggiungerlo. Solo per le sessioni cloud; sul Mac si usa la chiave vera. Nelle sessioni cloud serve sempre `NODE_USE_ENV_PROXY=1`.
- Provato offline: `read --offline` sulla fattura 4 produce l'estrazione con `new_payment_details` e `urgency`; `verify` sul receipt offline fallisce alla prima riga come deve. `tsc` e i 7 test vitest verdi.

### 2.4 NEAR AI Cloud con chiave vera: fatto (20 ottobre, stessa sessione)

Stefano ha rifatto il segreto di rete nell'ambiente cloud (tipo Bearer, host `cloud-api.near.ai`, header `Authorization` con prefisso `Bearer` e la sola chiave come valore). Da quel momento il proxy inietta la chiave e `NEAR_AI_API_KEY=proxy` funziona senza nuova sessione.

- `bursar read` sulle 4 fatture con `z-ai/glm-5.3-flash`: estrazioni giuste al primo tentativo, prompt invariato. Fattura 1: Acme, AH-0923, 480.00, NEAR `acmehosting.bursar-itlecew5.testnet`, flags vuoti, confidence 0,98. Fattura 2: DesignCo, DC-1107, 1250.00, Base `0x4f1ac0de...f801` in minuscolo, flags vuoti. Fattura 3: `vendor_id_guess` `legalpartnersllp` (il `matchVendor` dell'agente lo riconduce a `legalpartners` per inclusione), LP-2210, 9800.00. Fattura 4: `acme-billing-eu.testnet`, flags `new_payment_details` e `urgency`, confidence 0,95.
- `verify` su tutti e quattro i receipt: tutti i check `ok`, compreso `quote_tcb` con il collateral Intel scaricato da `pccs.phala.network` (TCB `UpToDate`). Il formato reale dell'API coincide con il codice: `signature_kind` `provider_tee`, `signing_algo` `ecdsa`, testo firmato `<model>:<sha256 req>:<sha256 res>`, `report_data` del quote con signer e nonce. Signer dei 4 run: `0x3b753b4406613c5e70ae640508632b600424fa0c`, mrtd `df4d77c857de652b...`.
- Cose viste nel receipt reale: la risposta ha `reasoning_content` (247 token di ragionamento, `content` è il JSON pulito); il report di attestazione porta anche `gateway_attestation`, `ohttp_attestation`, `ohttp_key_config`, e per modello `model_name`, `signing_public_key`, `nvidia_payload` (evidenza GPU HOPPER), `event_log`, `info` con `app_cert` e compose file, `compose_manager_attestation`. Nessuno di questi campi è ancora verificato (limite dichiarato nel README). Un receipt pesa 444 KB, quasi tutto il PNG in base64 nel `request_body` e l'evidenza NVIDIA. Costo di una lettura: circa 2.000 token in input (1.518 di immagine) e 360 in output.
- Il receipt della fattura 1 è committato in `app/test/fixtures/receipt-01-acme-hosting-0923.json`: due test vitest lo verificano offline (tutti i check tranne `quote_tcb` saltato) e lo rifiutano dopo la modifica di un byte; il README lo usa come "verify senza chiave". Contiene solo il body della richiesta, la risposta e l'attestazione: niente chiave, niente header. Le stringhe `Authorization: Bearer $${env:...}` dentro sono placeholder del compose file del provider.
- Fatto subito dopo (2.5): nuovo ambiente e `agent --once` con lettura TEE.

### 2.5 Terzo ambiente testnet, flusso completo con il TEE (20 ottobre, stessa sessione)

Ambiente usa e getta da faucet, chiavi generate nel container (perse quando il container sparisce): root `bursar-c34d05b8.testnet` (circa 10 NEAR residui), treasury `treasury.bursar-c34d05b8.testnet`, agent, executor, `tusdc.bursar-c34d05b8.testnet`, DAO `bursar-bursar-c34d05b8.sputnik-v2.testnet`, fornitori `acmehosting.` e `legalpartners.`; account di appoggio svuotati `bursar-fund-20eef818.testnet` e `bursar-fund-1868d68b.testnet`. Il faucet dà 10 NEAR per account: con tre account si arriva a 29,8, il setup ne usa circa 19. Il README punta a questo ambiente; i PDF in `invoices/samples` sono stati rigenerati con questi fornitori.

- Wasm compilati nel container (`rustup target add wasm32-unknown-unknown`, poi `build.sh`: 303 KB senza wasm-opt).
- `setup.ts`: allowance della chiave dell'agente da 0,05 a 1 NEAR. È solo un tetto al gas pagato dal saldo dell'agente (0,1 NEAR), non potere di spesa; serve per le chiamate dirette dal browser e con `--direct` quando il relayer non gira.
- Fatture 1-4 via relayer con `NEAR_AI_API_KEY=proxy`: #1 Paid, #2 Queued, #3 Approval `dao#0`, #4 Blocked payout_changed, tutte con `attestation_ref` `nearai:...`. `VoteApprove` su proposta 0 (script in `.bursar/vote.mts`, non committato): #3 Paid, saldo 4.720. Duplicato: #5 Blocked duplicate_invoice. `verify 1` tutti ok, `on_chain` compreso.
- La fixture `app/test/fixtures/receipt-01-acme-hosting-0923.json` ora è il receipt del pagamento #1 di questo contratto (con `tx` e `payment`), così `verify` sulla fixture controlla anche `on_chain` senza chiave.
- Due 502 "upstream request failed" dal gateway NEAR AI su 7 chiamate: `ai.ts` ora ritenta fino a 3 volte (2, 4, 6 secondi) su 429, 502, 503, 504. `agent.ts` rilegge `get_payment` fino a 5 volte se l'RPC risponde null subito dopo la transazione (successo con `payment: null` nel receipt del #4, poi corretto rilanciando).
- Non rifatti qui: rifiuto DAO e transfer_failed (pagamenti 6 e 7 restano sul contratto `itlecew5`, citato nel README).

### 2.6 Console web (20 ottobre, stessa sessione)

Stefano vuole provare Bursar dal web senza mettere nulla sul suo Mac. Le pagine artifact di claude.ai non possono chiamare host esterni (niente RPC, niente NEAR AI), quindi la pagina vive nella repo e si pubblica con GitHub Pages.

- `web/app.html`: file unico, nessun build. Fa tutto l'agente nel browser: pdf.js (cdnjs 4.10.38) rasterizza il PDF a PNG a 110 dpi ed estrae il testo; chiamata a NEAR AI Cloud con lo stesso prompt e lo stesso body di `ai.ts` (CORS aperto su `cloud-api.near.ai`, verificato con preflight); receipt identico a quello dell'agente; verifica in pagina con `@noble/curves` 2.4.0 e `@noble/hashes` 2.4.0 da jsdelivr (`+esm`): bytes, signed_text, recupero ECDSA, signer_kind, attestation signer e nonce, `report_data` letto a offset fisso 568..632 del quote TDX v4 (verificato contro `@phala/dcap-qvl` sulla fixture), extraction, completion_id, attestation_ref. `quote_tcb` è saltato nel browser (collateral Intel solo da CLI). Poi `request_payment` firmato nel browser con la chiave function-call dell'agente: borsh scritto a mano (Transaction + FunctionCall), ed25519 di noble, `send_tx` con `wait_until: EXECUTED_OPTIMISTIC`. Chiavi e API key in `localStorage`, con pulsante "Forget keys". La stessa dashboard di `index.html` in fondo.
- Perché la chiamata diretta: dal browser non c'è relayer raggiungibile. Serve che l'agente abbia un po' di NEAR: 150 TGas costano circa 0,15 NEAR prepagati (`NotEnoughBalance` con 0,1), `setup.ts` ora gli lascia 0,5 NEAR e la chiave ha allowance 1 NEAR. L'agente attuale è stato ricaricato a 0,5 dal root.
- Testato end to end in Chromium headless (Playwright, script in `app/.bursar/webtest.cjs`, non committato): fattura 1 -> #6 Blocked duplicate_invoice; nuova fattura `05-acme-hosting-1001.pdf` (Acme, AH-1001, 320 USDC, aggiunta a `make_invoices.py` apposta per il web) -> #7 Paid, tx `Ba9qpCqLAkQBsajtNCoVcufSH84F6nQywzx3kuyKm4b6`. Nessun errore in console. I PDF 1-4 non sono stati rigenerati (solo il 5 copiato), così i loro hash restano quelli dei pagamenti on chain.
- Hosting: `.github/workflows/pages.yml` pubblica `web/` con GitHub Pages a ogni push su `main` o a mano (`workflow_dispatch`). Va abilitato una volta in Settings, Pages, source "GitHub Actions". Su una repo privata Pages richiede un piano a pagamento (Pro o Team); il sito pubblicato è comunque raggiungibile da chi ha l'URL, ma la pagina non contiene segreti: le chiavi le inserisce l'utente nel suo browser. Se il piano non lo permette, alternativa: repo pubblica solo per `web/`, oppure aprire il file in locale.
- README: passo 9 "Do it all from a browser".

### 2.7 Grafica delle pagine web (20 ottobre, stessa sessione)

Stefano ha chiesto un'estetica "intuitiva ed esplosiva" studiando NEAR. Riferimenti usati: i token di near.org (Obsidian `#000`, Paper White, Signal Green `#00ec97` come unico colore saturo, Mint Sage `#c7f5d8`, bordi sottili, raggi 4px, niente ombre, bande alternate scure e chiare, particelle a stella verdi sul nero, il riquadro "AI" a scacchiera come firma), il carattere FK Grotesk (sostituto ufficiale: Space Grotesk, da Google Fonts) e le etichette di sezione `[ 01 / ... ]` del sito dell'hackathon. Carattere mono: IBM Plex Mono per hash e indirizzi.

- `web/style.css` condiviso. `web/index.html` è ora la landing (hero con la frase guida, tre ruoli, ultime 5 decisioni lette dal contratto `treasury.bursar-c34d05b8.testnet` o da `?treasury=`, verifica, come provarlo). La dashboard è diventata `web/dashboard.html`. `web/app.html` ridisegnata a bande numerate: 00 console, 01 read, 02 receipt (banda mint con il riquadro AI), 03 decide con il timbro grande PAID/BLOCKED, 04 treasury. Logica invariata; stessi id DOM, così lo script di test Playwright funziona ancora.
- Tema unico scuro con bande chiare, scelto apposta: niente toggle light/dark. Animazioni ridotte con `prefers-reduced-motion` (particelle ferme, niente timbro animato).
- Retry nel browser: il gateway NEAR AI risponde 502 a tratti sulle richieste con immagine (nel pomeriggio del 20 ottobre circa una su due, anche dalla CLI che ritenta 3 volte), e una risposta d'errore arriva senza header CORS, quindi il browser la vede come "Failed to fetch". `app.html` ritenta attestazione (3), completion (6, backoff 2-12 s) e firma (3). Se la serie di 502 dura più dei tentativi, la pagina mostra l'errore e si riprova.
- Screenshot desktop e telefono di landing e dashboard: nessun overflow orizzontale, nessun errore in console.
- La repo pubblica `DCSteve96/treasury-console` (GitHub Pages da `main`, root) contiene una copia di `web/`: `https://dcsteve96.github.io/treasury-console/`. Va riallineata a mano quando `web/` cambia (copia di `web/` e push). Da cancellare dopo i test o quando Bursar diventa pubblica.

### 2.8 Logo e console senza chiavi (20 ottobre, stessa sessione)

- Logo scelto da Stefano: tre barre (l'AI legge, il contratto decide in verde, l'executor muove) in un quadrato nero. `web/brand/mark.svg`, `favicon.svg`, `logo.svg` (lockup con la wordmark in Space Grotesk); il monogramma B scartato resta in `mark-monogram.svg`. Montato nelle tre pagine e nel titolo del README.
- Domanda di Stefano: come la provano i giudici senza treasury, chiave dell'agente e chiave NEAR AI? Risposta nella console: pulsante "Use the demo treasury" (compila rete, treasury `treasury.bursar-c34d05b8.testnet`, agente, modello; non la chiave) e quattro "recorded readings" in `web/samples/` (i receipt 1-4 dell'agente con `tx` e `payment`, 450 KB l'uno, più i 5 PDF). La pagina li verifica come una lettura viva e prepara il claim; "Request payment" su un receipt registrato dà `Blocked duplicate_invoice`. Testato in Chromium senza chiavi: tutti i check ok, flags della fattura 4 mostrati.
- Resta scoperto per chi non ha chiavi: premere "Request payment" richiede la chiave dell'agente. Opzione discussa: mettere nella pagina la chiave function-call dell'agente demo (potere limitato a `request_payment` sul treasury demo, 0,5 NEAR di gas, fornitori solo nostri): dimostrerebbe la tesi "anche con la chiave dell'agente non si ruba", ma va contro la lettera della regola 5 (niente segreti nella repo). Decisione a Stefano.
- Per i test in Chromium la pagina va servita via HTTP (le `fetch` dei sample non funzionano da `file://`): `app/.bursar/sampletest.cjs` tira su un server sull'IP del container e passa `bypass` al proxy di Playwright.

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
2. **NEAR AI Cloud con chiave vera**: `read` sulle 4 fatture e `verify` sui receipt veri fatti (2.4). Resta `npm run agent -- --once` senza `--offline` su un ambiente testnet nuovo; sistemare il prompt finché l'estrazione è giusta; poi `npm run dev verify <id>` su un receipt vero e correggere `verify.ts` se il formato reale differisce. Se un check fallisce per un motivo di formato va capito, non allentato.
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
