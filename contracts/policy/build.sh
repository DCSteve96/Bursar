#!/usr/bin/env bash
# Build the policy contract. If wasm-opt (binaryen) is on PATH it shrinks the wasm further;
# the contract works the same without it, it just costs more storage (about 1 NEAR per 100 KB).
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
W=target/wasm32-unknown-unknown/release/bursar_policy.wasm
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-sign-ext "$W" -o "$W.opt" && mv "$W.opt" "$W"
  echo "wasm-opt applied"
fi
ls -l "$W" | awk '{print "bursar_policy.wasm:", $5, "bytes"}'
