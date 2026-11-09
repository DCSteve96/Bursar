// Records the screen capture for the hackathon video on the live site (bursar.network), clean: no captions baked
// in. Captions, zooms and cuts are written to marks.json and turned into src/data.ts by marks-to-data.cjs, so the
// video overlays them in its own type. The treasury is a fresh one from `bursar setup --root <root>` with the DAO
// cleared (`clear_dao`), so the owner approves the held invoice with their own key; the sample invoices are the ones
// setup regenerated in invoices/samples. The captions after a decision follow the real outcome, never a script.
// usage: node record.cjs <root account> <out dir>
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const [root, out] = process.argv.slice(2);
const creds = (id) => JSON.parse(fs.readFileSync(`${process.env.HOME}/.near-credentials/testnet/${id}.json`));
const SITE = "https://bursar.network";
const samples = path.resolve(__dirname, "..", "invoices", "samples");
const W = 1600, H = 1000, BAR = 12; // the capture is 12 px taller: a clock strip at the bottom the video crops away
// The strip encodes the script's clock (deciseconds, 16 bits, one 100 px cell per bit) in every frame, so the
// capture's own timing (Playwright drops frames while the page is busy) can be mapped back to the marks.
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY } });
  const ctx = await browser.newContext({ viewport: { width: W, height: H + BAR }, recordVideo: { dir: out, size: { width: W, height: H + BAR } } });
  const t0 = Date.now();
  await ctx.addInitScript(({ t0, bar, w }) => {
    const cells = 16, cw = w / cells;
    const draw = () => {
      let d = document.getElementById("__clock");
      if (!d) {
        if (!document.documentElement) return;
        d = document.createElement("div"); d.id = "__clock";
        d.style.cssText = `position:fixed;left:0;bottom:0;width:${w}px;height:${bar}px;z-index:2147483647;display:flex;pointer-events:none;background:#000`;
        for (let i = 0; i < cells; i++) { const c = document.createElement("i"); c.style.cssText = `display:block;width:${cw}px;height:${bar}px;background:#000`; d.appendChild(c); }
        document.documentElement.appendChild(d);
      }
      const t = Math.floor((Date.now() - t0) / 100);
      for (let i = 0; i < cells; i++) d.children[i].style.background = (t >> (cells - 1 - i)) & 1 ? "#fff" : "#000";
    };
    setInterval(draw, 40);
  }, { t0, bar: BAR, w: W });
  const page = await ctx.newPage();
  const now = () => Number(((Date.now() - t0) / 1000).toFixed(2));
  const errors = []; page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  const marks = { captions: [], zooms: [], segments: [], skips: [] };
  const log = (...a) => console.log(now().toFixed(0) + "s", ...a);
  const cap = (text) => { marks.captions.push({ t: now(), text }); log("cap:", text.slice(0, 60)); };
  const wait = (ms) => page.waitForTimeout(ms);
  // a zoom on an element, as it sits in the viewport now
  const zoom = async (selector, ms, scale = 1.35) => {
    const box = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, selector).catch(() => null);
    if (box && box.w > 0) marks.zooms.push({ t: now(), ms, scale, ...box });
  };
  let seg = null;
  const segStart = () => { seg = now(); };
  const segEnd = () => { marks.segments.push({ start: seg, end: now() }); seg = null; };
  // a stretch of waiting the video drops: from `from` seconds to now, keeping `tail` seconds before now
  const skip = (from, tail) => { const end = now() - tail; if (end > from + 0.5) marks.skips.push({ from, to: end }); };
  const go = async (hash, ms = 1500) => { await page.evaluate((h) => { location.hash = h; window.scrollTo(0, 0); }, hash); await wait(ms); };
  const scrollTo = async (selector, ms = 800, offset = 90) => { await page.evaluate(({ s, o }) => { const e = document.querySelector(s); if (e) window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - o, behavior: "smooth" }); }, { s: selector, o: offset }); await wait(ms); };
  const text = async (sel) => (await page.innerText(sel)).replace(/\n/g, " | ");
  const read = async (file, caption) => {
    await go("#invoices", 900);
    cap(caption);
    for (let attempt = 1; ; attempt++) {
      await page.evaluate(() => { document.querySelector("#decision").hidden = true; document.querySelector("#receipt").hidden = true; document.querySelector("#readErr").hidden = true; const v = document.querySelector("#verdictPreview"); v.hidden = true; v.innerHTML = ""; window.scrollTo(0, 0); });
      await page.setInputFiles("#file", path.join(samples, file));
      await wait(2500);
      await scrollTo("#readSteps", 700, 160);
      const waitFrom = now() + 3.5; // the first seconds of the enclave's steps are shown, the rest cut
      await page.waitForFunction(() => !document.querySelector("#receipt").hidden || !document.querySelector("#readErr").hidden, null, { timeout: 180000 });
      const err = await page.$eval("#readErr", (e) => e.hidden ? "" : e.textContent);
      const failed = await page.$eval("#readSteps", (e) => /FAIL/.test(e.textContent));
      if (!err && !failed) { skip(waitFrom, 1.5); break; }
      log("read attempt", attempt, "failed:", err || "a step failed");
      if (attempt >= 4) throw new Error("read " + file + ": " + (err || "a step failed"));
      await wait(3000);
    }
    await page.waitForFunction(() => !document.querySelector("#verdictPreview").hidden, null, { timeout: 30000 }).catch(() => {});
    await scrollTo("#receipt", 1200, 70);
  };
  const REASON = { payout_changed: "the payout on the paper is not the one the owner registered. No money moved; the reason is on chain", duplicate_invoice: "same vendor and invoice number already accepted", unknown_vendor: "vendor not in the allowlist", over_payment_cap: "above the per-payment cap", over_daily_cap: "daily cap exceeded", over_monthly_budget: "vendor monthly budget exceeded", insufficient_treasury: "not enough USDC in the treasury" };
  const HOLD = { over_threshold: "amount at or above the approval threshold", no_order: "no purchase order or standing order covers it", flagged: "the reading carries flags", identity_mismatch: "the tax id on the paper is not the one recorded for this vendor", buyer_mismatch: "the invoice is not addressed to this company", withholding_mismatch: "the withholding shown differs from what the accountant set", payout_unconfirmed: "an operator's payout the owner has not confirmed", many_invoices: "this vendor already had its daily allowance without a person" };
  const outcomeCaption = (status, reason) => {
    const r = (reason || "").trim();
    if (status === "Paid") return "Paid, in the same transaction. Vendor, payout, caps, budget, orders, duplicates: all checked by the contract. Nobody had to look.";
    if (status === "Queued") return "Queued: the amount is reserved. The executor settles through NEAR Intents on a quote 1Click signed for the vendor's recorded payout, and the contract verifies that signature first.";
    if (status === "Blocked") return `Blocked: ${REASON[r] || r}.`;
    if (status === "Approval") return `Held for a person: ${r.split("+").map((x) => HOLD[x] || x).join("; ")}. The budget stays reserved until the owner or an approver decides.`;
    return `${status}${r ? ": " + r : ""}.`;
  };
  const submit = async (caption, after = 4500) => {
    cap(caption);
    await scrollTo("#submit", 700, 420);
    await wait(900);
    if (process.env.DRY) { cap("(dry run: no request)"); await wait(1500); return { status: "dry" }; }
    await page.click("#submit");
    const waitFrom = now() + 2.5;
    await page.waitForFunction(() => !document.querySelector("#decision").hidden || !document.querySelector("#submitErr").hidden, null, { timeout: 120000 });
    const err = await page.$eval("#submitErr", (e) => e.hidden ? "" : e.textContent); if (err) throw new Error("submit: " + err);
    skip(waitFrom, 0.8);
    await scrollTo("#decision", 900, 300);
    const status = (await page.$eval("#decStatus", (e) => e.textContent)).trim();
    let reason = await page.$eval("#decReason", (e) => e.hidden ? "" : e.textContent);
    if (status === "Approval" || !reason) { try { const id = Number((await text("#decId")).replace(/\D/g, "")); const p = await page.evaluate(async ({ id, t }) => { const r = await fetch("https://test.rpc.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: t, method_name: "get_payment", args_base64: btoa(JSON.stringify({ id })) } }) }); const j = await r.json(); return JSON.parse(String.fromCharCode(...j.result.result)); }, { id, t: `treasury.${root}` }); reason = p?.reason || reason; } catch {} }
    log(`${await text("#decId")} ${status} ${reason}`);
    cap(outcomeCaption(status, reason));
    await zoom("#decision", after - 1000, 1.3);
    await wait(after);
    return { status, reason };
  };
  try {
    const rootKey = creds(root), agentKey = creds(`agent.${root}`);
    // the profile: owner and agent keys of the fresh treasury, as "Download the keys" would have left them
    await page.goto(SITE + "/console#start"); await wait(1200);
    await page.evaluate(({ root, rootKey, agentKey }) => {
      const prof = { network: "testnet", treasury: `treasury.${root}`, agent: agentKey.account_id, agentKey: agentKey.private_key, owner: root, ownerKey: rootKey.private_key, ownerKeyKind: "", label: "Northwind Studio", operator: "", operatorKey: "", operatorRole: "", payer: "", payerKey: "", inboxToken: "" };
      for (const [k, v] of Object.entries(prof)) localStorage.setItem("bursar." + k, v);
      localStorage.setItem("bursar.profiles", JSON.stringify([prof]));
    }, { root, rootKey, agentKey });
    await page.evaluate(() => { location.hash = "#overview"; }); await page.reload(); await wait(4000);
    // ---- segment A: the console, the first two invoices
    segStart();
    cap("The console. Every number is read from the company's own NEAR contract: balance, what waits for a person, the last decisions.");
    await zoom("#stats", 3500, 1.3);
    await wait(5500);
    cap("15,000 test USDC in the treasury. Limits the owner wrote into the contract: 10,000 per payment, 20,000 a day, a person decides from 2,000.");
    await wait(5000);
    if (process.env.SHORT) { await go("#vendors"); cap("short run"); await wait(3000); segEnd(); throw new Error("short run done"); }
    await go("#vendors");
    cap("Vendors, registered once by the owner: payout, tax id, monthly budget. The AI can never add one or change an address.");
    await wait(5500);
    await go("#orders");
    cap("Orders: a standing order for hosting, purchase orders for the rest. An invoice nothing covers waits for a person.");
    await wait(5000);
    await read("01-acme-hosting-0923.pdf", "An invoice. The PDF is rendered in the browser and read inside NEAR AI Cloud's enclave: attestation first, then a signed receipt.");
    await scrollTo("#verdictPreview", 1200, 160);
    cap("Vendor, number, amount, due date, the payout printed on the paper, the flags: read in the enclave, signature verified in this page.");
    await zoom("#verdictPreview", 3500, 1.3);
    await wait(5000);
    await submit("Request payment. The agent's key can only ask. The contract decides.");
    await read("04-acme-hosting-0924-fraud.pdf", "Same vendor, next invoice: 'please note our new bank details'. The classic fraud.");
    await wait(2500);
    await submit("Request payment. Will the contract notice?", 5500);
    segEnd();
    // ---- segment B: held and approved, cross-chain, attention, analytics
    await go("#overview", 2500);
    segStart();
    await read("03-legalpartners-2210.pdf", "9,800 USDC from the law firm. At or above the threshold the owner set: a person must decide.");
    await wait(2000);
    const big = await submit("Request payment, above the threshold.", 4000);
    if (big.status === "Approval") {
      cap("The owner approves with their own key. Same contract, same rules.");
      await scrollTo("#approveRow", 600, 420);
      await page.click("#approve");
      const waitFrom = now() + 2.5;
      await page.waitForFunction(() => document.querySelector("#decStatus").textContent.trim() === "Paid" || !document.querySelector("#submitErr").hidden, null, { timeout: 120000 });
      skip(waitFrom, 0.8);
      log("approved:", await text("#decStatus"));
      cap("Paid. The approval is a transaction too: who, when, which invoice, all on chain.");
      await zoom("#decision", 3000, 1.3);
      await wait(4500);
    }
    await read("02-designco-1107.pdf", "A vendor paid on Base. Same reading, same checks.");
    await wait(2000);
    await submit("Request payment for a vendor on another chain.", 6500);
    await go("#attention");
    cap("Attention: what the rules held and what they refused, each with its reason. Approve, cancel, or open a DAO proposal.");
    await wait(6000);
    await go("#analytics", 4500);
    cap("Analytics straight from the payments on chain: by vendor, by month, withheld for the state. Excel and CSV for the accountant.");
    await wait(6000);
    segEnd();
    // ---- segment C: the explorer and the receipt check on the landing page
    await page.goto(SITE + "/explorer"); await wait(3500);
    segStart();
    cap("The explorer: every Bursar treasury, public and verifiable. Each contract's code hash is checked against the published builds.");
    await wait(6000);
    await page.goto(SITE + "/"); await wait(1500);
    await scrollTo("#verify", 1500, 140);
    await page.waitForFunction(() => document.querySelectorAll("#checks .chk.ok").length >= 3, null, { timeout: 30000 }).catch(() => {});
    cap("Anyone can check a reading: the enclave's signature, the nonce, the attestation quote. Here, in the page, against the receipt behind payment #1 of the demo treasury.");
    await zoom("#checks", 4000, 1.25);
    await wait(5500);
    await page.click("#tamper"); await wait(1200);
    cap("Change one byte of what the model read and the signature fails. The AI cannot hide what it read.");
    await zoom("#checks", 4000, 1.25);
    await wait(6000);
    segEnd();
    await wait(1500);
  } catch (e) { console.error("FAILED:", e.message); await page.screenshot({ path: out + "/fail.png", fullPage: true }).catch(() => {}); }
  console.log("page errors:", errors);
  await ctx.close(); await browser.close();
  fs.writeFileSync(out + "/marks.json", JSON.stringify(marks, null, 1));
  console.log("done", fs.readdirSync(out));
})();
