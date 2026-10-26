// Telegram approvals in the console: connect an approver chat, receive a PDF, approve it from the (stubbed) bot,
// see the inbox state, read and decide in the console, see what the bot tells the approver and the vendor.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const root = "/home/user/Bursar/web";
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".pdf": "application/pdf", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const srv = http.createServer((req, res) => { let f = path.join(root, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html")); fs.readFile(f = (fs.existsSync(f) || /\.[a-z0-9]+$/i.test(f) ? f : f + ".html"), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); res.end(d); }); });
const RELAY = "http://192.0.2.2:8100", SECRET = { "x-telegram-bot-api-secret-token": "s3cret" };
const post = (p, body, h = {}) => fetch(RELAY + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then((r) => r.json());
const creds = JSON.parse(fs.readFileSync(process.env.HOME + "/.near-credentials/testnet/agent.bursar-66235736.testnet.json"));
const ownerCreds = JSON.parse(fs.readFileSync(process.env.HOME + "/.near-credentials/testnet/bursar-66235736.testnet.json"));
srv.listen(8095, "0.0.0.0", async () => {
  const out = process.argv[2];
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: "192.0.2.2" } });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept()); // the console asks before using a relay or RPC given in the URL
  const text = async (sel) => (await page.innerText(sel)).replace(/\n/g, " | ");
  try {
    await page.goto(`http://192.0.2.2:8095/console.html?relay=${encodeURIComponent(RELAY)}#start`); await page.waitForTimeout(800);
    await page.waitForSelector("#ask[open]", { timeout: 8000 }).then(() => page.click("#askYes")).catch(() => {}); // "Use a different reading relay?"
    await page.evaluate(({ c, o }) => { const prof = { network: "testnet", treasury: "treasury.bursar-66235736.testnet", agent: c.account_id, agentKey: c.private_key, label: "Test Co", owner: o.account_id, ownerKey: o.private_key, operator: "", operatorKey: "", operatorRole: "", ownerKeyKind: "", payer: "", payerKey: "", inboxToken: "" }; for (const [k, v] of Object.entries(prof)) localStorage.setItem("bursar." + k, v); localStorage.setItem("bursar.profiles", JSON.stringify([prof])); }, { c: creds, o: ownerCreds });
    await page.evaluate(() => { location.hash = "#settings"; }); await page.reload(); await page.waitForTimeout(2500);
    console.log("company:", await text("#companyName"));
    await page.click("#tgApprover");
    await page.waitForFunction(() => !document.querySelector("#tgApproverOut").hidden || !document.querySelector("#tgErr").hidden, null, { timeout: 30000 });
    const terr = await page.$eval("#tgErr", (e) => e.hidden ? "" : e.textContent); if (terr) throw new Error("connect: " + terr);
    await page.screenshot({ path: out + "/approver-link.png", fullPage: true });
    const code = (await text("#tgApproverCmd")).match(/\/start (\w+)/)[1];
    console.log("approver link:", await text("#tgApproverLink"), "| open:", await text("#tgApproverOpen"), "| vendor block hidden:", await page.$eval("#tgOut", (e) => e.hidden));
    await post("/tg/webhook", { message: { message_id: 1, chat: { id: 500, type: "private" }, from: { id: 500, first_name: "Stefano" }, date: 1760000000, text: `/start ${code}` } }, SECRET);
    // a vendor chat for Acme
    await page.selectOption("#tgFor", "acmehosting"); await page.click("#tgConnect");
    await page.waitForFunction(() => document.querySelector("#tgCmd").textContent.indexOf(arguments[0]) < 0, code, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    const code2 = (await text("#tgCmd")).match(/\/start (\w+)/)[1];
    await post("/tg/webhook", { message: { message_id: 1, chat: { id: 777, type: "group", title: "Acme invoices" }, from: { id: 701, first_name: "Mario" }, date: 1760000000, text: `/start ${code2}` } }, SECRET);
    await page.waitForTimeout(500); await page.evaluate(() => { location.hash = "#inbox"; }); await page.waitForTimeout(800); await page.evaluate(() => { location.hash = "#settings"; }); await page.waitForTimeout(1200);
    console.log("status:", await text("#tgStatus")); console.log("chats:", await text("#tgChats"));
    await page.screenshot({ path: out + "/approver-settings.png", fullPage: true });
    // two invoices arrive: 01 (regular) and 06 (new bank details)
    await post("/tg/webhook", { message: { message_id: 11, chat: { id: 777, type: "group", title: "Acme invoices" }, from: { id: 701, first_name: "Mario" }, date: 1760000100, document: { file_id: "F-01", file_name: "AH-0923.pdf", mime_type: "application/pdf", file_size: 2273 }, caption: "October hosting" } }, SECRET);
    await post("/tg/webhook", { message: { message_id: 12, chat: { id: 777, type: "group", title: "Acme invoices" }, from: { id: 701, first_name: "Mario" }, date: 1760000200, document: { file_id: "F-06", file_name: "AH-1002.pdf", mime_type: "application/pdf", file_size: 2300 } } }, SECRET);
    let sent = await fetch(RELAY + "/__sent").then((r) => r.json());
    console.log("bot:", sent.map((m) => `${m.method} [${m.chat_id}] ${m.text.slice(0, 90).replace(/\n/g, " / ")}${m.reply_markup?.inline_keyboard?.length ? " [buttons]" : ""}`).join("\n     "));
    // the approver presses Approve on the first and types "no" replying to the second
    const asked = sent.filter((m) => m.method === "sendDocument");
    await post("/tg/webhook", { callback_query: { id: "c1", from: { id: 500, first_name: "Stefano" }, message: { message_id: asked[0].message_id ?? 1001, chat: { id: 500 } }, data: "a:11-777" } }, SECRET);
    await page.evaluate(() => { location.hash = "#inbox"; }); await page.waitForTimeout(1500);
    console.log("inbox:", await text("#inboxGroups"), "|", await text("#inboxFoot"));
    await page.screenshot({ path: out + "/inbox-approved.png", fullPage: true });
    // the console reads the approved one and decides (the agent is not running here)
    await page.click('button.act[data-act="inboxRead"][data-id="11-777"]');
    await page.waitForFunction(() => !document.querySelector("#receipt").hidden || !document.querySelector("#readErr").hidden, null, { timeout: 120000 });
    const rerr = await page.$eval("#readErr", (e) => e.hidden ? "" : e.textContent); if (rerr) throw new Error("read: " + rerr);
    await page.waitForFunction(() => !document.querySelector("#verdictPreview").hidden, null, { timeout: 30000 }).catch(() => {});
    console.log("preview:", await text("#verdictPreview"));
    await page.click("#submit");
    await page.waitForFunction(() => !document.querySelector("#decision").hidden || !document.querySelector("#submitErr").hidden, null, { timeout: 120000 });
    const serr = await page.$eval("#submitErr", (e) => e.hidden ? "" : e.textContent); if (serr) throw new Error("submit: " + serr);
    console.log("decision:", await text("#decId"), await text("#decStatus"), "|", await text("#decReason").catch(() => ""));
    await page.waitForTimeout(3000);
    const before = sent.length; sent = await fetch(RELAY + "/__sent").then((r) => r.json());
    console.log("bot after:", sent.slice(before).map((m) => `${m.method} [${m.chat_id}] ${m.text.slice(0, 160).replace(/\n/g, " / ")}`).join("\n     "));
    await page.evaluate(() => { location.hash = "#inbox"; }); await page.waitForTimeout(1500);
    console.log("inbox after:", await text("#inboxGroups"));
    await page.screenshot({ path: out + "/inbox-after.png", fullPage: true });
  } catch (e) { console.error("FAILED:", e.message); await page.screenshot({ path: out + "/fail.png", fullPage: true }).catch(() => {}); }
  console.log("page errors:", errors);
  await browser.close(); srv.close(); process.exit(0);
});
