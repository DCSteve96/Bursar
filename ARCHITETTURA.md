# Bursar: architettura (bozza del 20 ottobre 2026)

Nome di lavoro: **Bursar** (il tesoriere di un college: tiene i conti e paga, ma non decide il budget). Se preferisci un altro nome si cambia in un minuto, ma serve prima della submission perché deve essere unico nell'hackathon.

Frase guida per i giudici: **The AI reads. The contract decides. A dumb executor moves the money.** L'agente AI non vede mai una chiave con potere di spesa e non sceglie mai un indirizzo di pagamento.

Tracce: `realworld` (principale), `business`, `privacy`, `security`.

## 1. Le parti

```
inbox (PDF)  ->  agent (Node, NEAR AI Cloud in TEE)  ->  policy contract (NEAR, Rust)
                                                              |-> Paid        USDC su NEAR al fornitore
                                                              |-> Queued     executor -> NEAR Intents -> USDC su Base/Arbitrum/Solana
                                                              |-> Approval   proposta Sputnik DAO (Trezu) -> firma umana -> approve
                                                              |-> Blocked    fornitore ignoto, tetto, budget, duplicato, wallet cambiato
web dashboard + MCP server leggono il contratto e il registro
```

### 1.1 Policy contract (`contracts/policy`, Rust, near-sdk 5)

Deployato sull'account dell'azienda (es. `acme-treasury.testnet`). È l'unico posto dove stanno i soldi: l'azienda deposita USDC (NEP-141) sul contratto.

Stato:
- `owner`: l'azienda (account umano o DAO).
- `agent`: il sub-account dell'agente (`agent.acme-treasury.testnet`), con una function-call key che può chiamare solo `request_payment`.
- `executor`: account del processo che parla con Intents (chiave dell'azienda, nessuna AI).
- `dao`: account Sputnik per le approvazioni sopra soglia.
- `usdc`: contratto del token.
- `limits`: `per_payment_cap`, `daily_cap`, `approval_threshold`.
- `vendors: Map<vendor_id, Vendor>` con `name`, `payout` (`{near: account}` oppure `{chain, address}`), `monthly_budget`, `spent_this_month`, `month`, `last_payout_hash`.
- `payments: Map<id, Payment>` con stato (`Paid | Queued | Approval | Blocked | Settled | Cancelled`), importo, fornitore, numero fattura, hash della fattura, riferimento all'attestazione TEE, motivo del blocco.
- `invoice_index: Set<hash(vendor_id, invoice_number)>` contro i duplicati.
- `paused`.

Metodi:
- owner: `add_vendor`, `update_vendor`, `set_limits`, `set_agent`, `set_executor`, `set_dao`, `pause`, `withdraw`.
- agent (solo questa): `request_payment(claim)` dove `claim = {vendor_id, invoice_number, amount, due_date, invoice_hash, payout_seen: {chain,address}, attestation_ref}`.
  - controlli in ordine: paused, vendor esiste, `payout_seen == vendor.payout` (altrimenti **Blocked: payout_changed**, la frode della fattura modificata), duplicato, `amount <= per_payment_cap`, budget mensile, tetto giornaliero.
  - sotto `approval_threshold`: se il fornitore è su NEAR -> `ft_transfer` immediato (**Paid**); se è su un'altra chain -> **Queued**.
  - sopra soglia -> **Approval**: cross-contract call `dao.add_proposal` di tipo FunctionCall verso `approve_payment(id)` su questo contratto. I consiglieri approvano da Trezu; quando la proposta passa, la DAO chiama `approve_payment`, che riprende il flusso Paid/Queued.
- executor (solo questa): `settle(id, deposit_address, quote_id, recipient)`: il contratto verifica `recipient == vendor.payout` e solo allora trasferisce USDC al `deposit_address` di Intents; poi `mark_settled(id, dest_tx)`.
- view: `get_payment`, `list_payments`, `get_vendor`, `get_limits`, `get_stats`.

Ogni transizione emette un evento NEP-297 (`bursar` standard) così dashboard e MCP leggono tutto dalla chain.

### 1.2 Agent (`agent/`, TypeScript)

- Guarda una cartella `inbox/` (demo) o riceve un upload dalla dashboard.
- Estrae il testo dal PDF (`pdf-parse`). Se NEAR AI Cloud espone un modello con visione in TEE lo usiamo direttamente, altrimenti testo.
- Chiede a NEAR AI Cloud (API compatibile OpenAI, modello in TEE) un JSON: fornitore, numero, importo, valuta, scadenza, coordinate di pagamento viste, segnali sospetti (testo tipo "nuovo IBAN", urgenza, dominio email diverso).
- Salva l'attestazione della richiesta e la mette in `attestation_ref` (hash + link).
- Firma `request_payment` con la function-call key del sub-account, inviata via **meta transaction** a un relayer: l'agente non possiede NEAR per il gas.
- Non conosce il payout del fornitore: lo "vede" solo nella fattura e lo riporta; il confronto lo fa il contratto.

### 1.3 Executor (`executor/`, TypeScript)

Processo senza AI, chiave dell'azienda. Per ogni pagamento `Queued`:
1. legge dal contratto il payout del fornitore;
2. chiede a Intents (1-Click API) un quote USDC NEAR -> USDC sulla chain di destinazione con `recipient = payout.address`;
3. chiama `settle(id, deposit_address, quote_id, recipient)`;
4. attende lo stato finale di Intents e chiama `mark_settled(id, dest_tx)`.

Se Intents non funziona su testnet, la demo cross-chain gira su mainnet con pochi dollari (da verificare la prima sera).

### 1.4 Approvazioni (Sputnik DAO v2 + Trezu)

Una DAO di test con due consiglieri (tu e un secondo account). Trezu è la UI: la proposta creata dal contratto appare lì e si approva con un clic. Nel video si vede il pagamento grosso che aspetta la firma umana.

### 1.5 MCP server (`mcp/`)

Strumenti: `submit_invoice(path)`, `list_payments`, `get_payment(id)`, `vendors`, `approve_payment(id)` (per il consigliere), `explain_decision(id)`. Serve a due cose: Claude Code è giudice e può eseguire tutta la demo da solo; e dimostra che il tesoriere si usa da qualsiasi assistente.

### 1.6 Dashboard (`web/`)

Una pagina: inbox, decisioni con il motivo, registro con link a tx e attestazione, budget per fornitore. Minimale, statica, legge la chain via RPC.

## 2. Le quattro fatture della demo

1. `acme-hosting-0923.pdf`: 480 USDC, fornitore su NEAR, sotto soglia -> **Paid** in un secondo.
2. `designco-1107.pdf`: 1.250 USDC, fornitore su Base -> **Queued** -> arriva su Base via Intents.
3. `legalpartners-2210.pdf`: 9.800 USDC, sopra soglia -> **Approval** -> firma su Trezu -> pagato.
4. `acme-hosting-0924.pdf`: stesso fornitore della 1, ma con "please note our new wallet" -> **Blocked: payout_changed**. Poi la stessa fattura 1 rimandata -> **Blocked: duplicate**.

## 3. Primitive NEAR usate (da nominare nel README)

- NEAR AI Cloud, inferenza in TEE con attestazione (privacy).
- Function-call access key limitata a un metodo, sub-account per l'agente (security).
- Meta transaction NEP-366, l'agente non paga gas (realworld).
- NEAR Intents per pagare il fornitore sulla chain che vuole (realworld, business).
- Sputnik DAO / Trezu per le approvazioni umane (business, social).
- Eventi NEP-297 come registro contabile leggibile.

## 4. Rischi e verifiche prima del 1° novembre

1. Intents 1-Click su testnet: se no, mainnet con 20-30 dollari.
2. NEAR AI Cloud: modelli in TEE disponibili, formato dell'attestazione, costo.
3. Relayer per meta transaction su testnet: se non ce n'è uno pubblico, ne facciamo uno piccolo (30 righe).
4. Sputnik FunctionCall proposal che richiama il nostro contratto: gas e bond.

## 5. Cosa serve da te

- Account NEAR mainnet per il premio.
- Un account testnet con qualche NEAR per creare `acme-treasury.testnet`, il sub-account dell'agente, l'executor e la DAO.
- Chiave NEAR AI Cloud (top-up minimo).
- Conferma del nome.
