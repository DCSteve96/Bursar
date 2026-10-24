// Meteor Wallet through its own SDK (Meteor Connect) when the browser extension is on this page.
// NEAR Connect runs each wallet's code in a sandboxed iframe, which cannot see the extension, so on its own the
// picker always opens Meteor's web wallet. The SDK runs on the page, sees the extension and offers it in its own popup.
// Loaded only when the extension is detected: the bundle is 1.4 MB.
const SDK = "./vendor/meteor-sdk.js"; // @meteorwallet/sdk 3.24.0 bundled by vendor/build-meteor-sdk.mjs: the CDN builds of it do not load
export const meteorExtensionPresent = () => typeof window !== "undefined" && (window.meteorCom != null || window.meteorComV2 != null);
let sdkPromise = null;
const sdk = () => sdkPromise || (sdkPromise = import(SDK).then(async (m) => { const mc = new m.MeteorConnect(); await mc.initialize({ storage: m.webpage_local_storage }); return { m, mc }; }));
const target = (network) => ({ blockchain: "near", network: network || "testnet" });
const unsupported = () => { throw new Error("not supported through the Meteor extension here"); };

/** The extension injects its bridge a moment after the page loads, later still when its background process is waking up: wait for it. */
export const waitForMeteorExtension = (ms = 3000) => new Promise((res) => { const t0 = Date.now(); const tick = () => meteorExtensionPresent() ? res(true) : Date.now() - t0 >= ms ? res(false) : setTimeout(tick, 100); tick(); });
let registered = false;
/** Register Meteor as an injected wallet of NEAR Connect. Call it after the connector exists; returns false when there is no extension. Safe to call again: it registers once. */
export async function registerMeteorExtension(waitMs = 3000) {
  if (registered) return true;
  if (!(await waitForMeteorExtension(waitMs))) return false;
  registered = true;
  const { m, mc } = await sdk();
  const account = (network) => mc.getAccount(target(network));
  const run = async (id, input) => (await mc.createAction({ id, input })).promptForExecution();
  const wallet = {
    manifest: {
      id: "meteor-extension", name: "Meteor Wallet (extension)", description: "The browser extension installed here; the plain Meteor Wallet entry opens the web wallet", website: "https://meteorwallet.app",
      icon: "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/main/assets/meteor-logo-svg.svg", version: "3.24.0", executor: "", type: "injected", platform: [], permissions: {},
      features: { signMessage: true, signTransaction: false, signAndSendTransaction: true, signAndSendTransactions: true, signInWithoutAddKey: true, signInAndSignMessage: false, signDelegateActions: false, addFunctionCallKey: false, mainnet: true, testnet: true },
    },
    signIn: async ({ network } = {}) => { const a = await run("near::sign_in", { target: target(network) }); return [{ accountId: a.identifier.accountId, publicKey: a.publicKeys?.[0]?.publicKey }]; },
    getAccounts: async ({ network } = {}) => { const a = await account(network); return a ? [{ accountId: a.identifier.accountId }] : []; },
    signOut: async ({ network } = {}) => { const a = await account(network); if (a) await run("near::sign_out", { target: a.identifier }); },
    signAndSendTransactions: async ({ network, transactions }) => {
      const a = await account(network); if (!a) throw new Error("not signed in with Meteor");
      return run("near::sign_transactions", { target: a.identifier, useFunctionCallKey: false, transactions: transactions.map((t) => ({ receiverId: t.receiverId, actions: t.actions.map(m.convertSelectorActionToNearAction) })) });
    },
    signAndSendTransaction: async (p) => (await wallet.signAndSendTransactions({ network: p.network, transactions: [{ receiverId: p.receiverId, actions: p.actions }] }))[0],
    // NEP-413: the console derives its vault key from this signature, so it must be deterministic (ed25519 is).
    signMessage: async ({ network, message, nonce, recipient, state } = {}) => {
      const a = await account(network); if (!a) throw new Error("not signed in with Meteor");
      const r = await run("near::sign_message", { target: a.identifier, messageParams: { message, nonce, recipient, state } });
      return { accountId: r?.accountId || a.identifier.accountId, publicKey: r?.publicKey, signature: r?.signature, state: r?.state };
    },
    signInAndSignMessage: unsupported, signDelegateActions: unsupported, addFunctionCallKey: unsupported,
  };
  window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet }));
  return true;
}
