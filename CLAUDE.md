# Bursar: istruzioni per Claude Code

Leggi questo file per intero prima di toccare qualsiasi cosa. Poi leggi `HANDOFF.md` (stato del progetto, decisioni prese, API verificate) e `README.md` (quello che vedranno i giudici).

## Cos'è

Bursar è un tesoriere AI per piccole aziende: legge fatture PDF in un TEE (NEAR AI Cloud), chiede a un contratto NEAR di pagarle, e il contratto decide dentro limiti che l'AI non può cambiare. Progetto per il NEAR HACKATHON (1-14 novembre 2026). Tracce: `realworld`, `business`, `privacy`, `security`.

Frase guida, da non perdere mai: **The AI reads. The contract decides. A dumb executor moves the money.**

## Regole fisse (non negoziabili)

1. **Separato da Epoch.** Nessun riferimento a Epoch, Sui, $EPT, Walrus o ai prodotti Epoch nel codice, nei testi, nei post. Progetto a sé.
2. **Non custodial.** I fondi stanno nel contratto dell'azienda, con le sue chiavi. L'AI non sceglie mai un indirizzo. L'executor può mandare fondi solo verso il payout registrato dal proprietario (il contratto lo verifica). Niente che renda Bursar un servizio di pagamento o un custode (MiCA). Nel README resta la frase "software, not a payment service".
3. **Solo USDC** negli esempi e nei testi, mai USDT.
4. **Fatture finte.** Mai dati di persone o aziende reali nei PDF di esempio, nel video o nei test.
5. **Niente segreti nella repo.** Chiavi solo in `~/.near-credentials` o in variabili d'ambiente. `.env.*` è in `.gitignore`. Se Stefano incolla una chiave in chat, va considerata compromessa e ruotata.
6. **Niente mainnet senza conferma esplicita di Stefano**, e niente transazioni firmate con le sue chiavi senza che lo chieda lui per quella specifica azione.
7. **Git**: commit e push li fa Claude Code solo se Stefano lo ha autorizzato in questa repo. In dubbio, chiedi. Messaggi di commit in inglese, brevi, al presente.
8. **Submission**: una sola, non modificabile. Mai inviare il POST a `nearhackathon.com/api/applications` senza che Stefano abbia confermato il payload completo stampato a schermo.

## Stile dei testi (post, README, messaggi)

- Niente em-dash, mai. Niente emoji, mai.
- Testi in inglese per i giudici e per X; a Stefano si risponde in italiano, e ogni testo inglese redatto per lui va accompagnato dalla traduzione italiana.
- Post e messaggi da copiare: in un blocco di codice plain text. Se scrive da telefono, testo semplice diretto nel messaggio.
- Risposte concise, oneste, dirette. Niente rassicurazioni vuote.

## Struttura

```
contracts/policy      contratto di policy, Rust, near-sdk 5 (21 unit test)
contracts/test-usdc   NEP-141 usa e getta per testnet, con mint aperto
contracts/registry    registro pubblico delle tesorerie (explorer e login lo leggono, 4 unit test)
app/src/              TypeScript, near-api-js 7
  config.ts           tutta la configurazione da env; asset id USDC per chain (Intents)
  near.ts             helper NEAR, meta transaction (NEP-366)
  ai.ts               NEAR AI Cloud: attestazione prima, estrazione JSON, firma della risposta; parser offline per i PDF di esempio
  agent.ts            watcher dell'inbox, PDF -> PNG (pdftoppm) e testo (pdftotext), claim -> request_payment
  relayer.ts          relayer NEP-366 che accetta solo request_payment dall'agente
  executor.ts         NEAR Intents 1-Click per i fornitori su altre chain (solo mainnet)
  mcp.ts              server MCP (submit_invoice, list_payments, get_payment, explain_decision, vendors, treasury_status)
  setup.ts            crea account, deploya, finanzia, aggiunge fornitori, crea la DAO, lascia all'agente una sola chiave
  cli.ts              bursar setup|agent|submit|read|executor|relayer|mcp|status|verify|sync
web/                  index.html (landing), login.html (wallet, invito, chiavi), explorer.html (la rete), docs.html, dashboard.html (una tesoreria), app.html (console: onboarding, lettura TEE, verifica, request_payment dal browser), meteor.js (estensione Meteor via SDK), vendor/ (SDK Meteor impacchettato), style.css, brand/, samples/, contracts/
relay/                Cloudflare Worker: relay di lettura (tiene la chiave NEAR AI, inoltra i byte intatti, limiti giornalieri)
invoices/             make_invoices.py e 9 PDF di esempio (5 e 6 per la console, 7 e 8 per i tax id, 9 per la ritenuta)
```

## Comandi

```bash
# contratti
(cd contracts/policy && cargo test && cargo build --release --target wasm32-unknown-unknown)
(cd contracts/test-usdc && cargo build --release --target wasm32-unknown-unknown)
(cd contracts/registry && cargo test && ./build.sh)
# app
cd app && npm install && npx tsc -p . --noEmit
npx tsx src/cli.ts setup --root <account>.testnet
set -a; source .env.testnet; set +a
npm run relayer &
npm run agent -- --once --offline
npm run dev status
```

Prerequisiti sul Mac: Rust stable con target `wasm32-unknown-unknown`, Node 22+, `poppler` (brew install poppler), Python 3 con `reportlab` solo per rigenerare le fatture.

## Come lavorare

- Prima di cambiare il contratto: `cargo test`. Dopo: ricompila il wasm e, se la firma di un metodo cambia, aggiorna `near.ts`, `mcp.ts` e il README.
- Testnet è il posto per provare tutto, tranne Intents (solo mainnet) e Trezu (solo mainnet).
- Ogni funzione nuova deve avere un passo "do X, see Y" nel README: i giudici AI (Claude Code e Codex) eseguono il README.
- Mantieni il wasm piccolo: 473 KB costano 4,7 NEAR di storage. Se aggiungi dipendenze Rust, controlla la dimensione.
- Rileggi `https://nearhackathon.com/HACKATHON.md` prima della submission: le regole possono cambiare.

## Prima di rendere pubblica la repo

`HANDOFF.md`, `ARCHITETTURA.md` e questo stesso `CLAUDE.md` sono appunti interni in italiano: contengono riferimenti a Epoch, decisioni private e account di prova. Prima di passare la repo a pubblica vanno rimossi dalla history o sostituiti da una versione in inglese senza quei contenuti (un `CLAUDE.md` breve per i giudici AI va bene). Il README è l'unico documento pensato per l'esterno.
