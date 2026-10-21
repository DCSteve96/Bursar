// Rebuild vendor/meteor-sdk.js: the Meteor Connect SDK as one browser ES module.
// The CDN builds (esm.sh, jsDelivr) of @meteorwallet/sdk do not load in a browser (broken sub-imports), so it is bundled here.
//   mkdir -p /tmp/msdk && cd /tmp/msdk && npm init -y && npm i @meteorwallet/sdk@3.24.0 near-api-js@6 esbuild esbuild-plugin-polyfill-node
//   cp <repo>/web/vendor/build-meteor-sdk.mjs . && node build-meteor-sdk.mjs && cp meteor-sdk.js <repo>/web/vendor/
import { build } from "esbuild";
import { polyfillNode } from "esbuild-plugin-polyfill-node";
import { writeFileSync } from "node:fs";
writeFileSync("entry.js", 'export { MeteorConnect, webpage_local_storage, convertSelectorActionToNearAction } from "@meteorwallet/sdk";\n');
await build({
  entryPoints: ["entry.js"], bundle: true, format: "esm", minify: true, platform: "browser", target: "es2022", outfile: "meteor-sdk.js", define: { global: "globalThis" },
  plugins: [polyfillNode({ globals: { buffer: true, process: true }, polyfills: { buffer: true, util: true, events: true, crypto: false } })],
  logLevel: "error",
});
console.log("built meteor-sdk.js");
