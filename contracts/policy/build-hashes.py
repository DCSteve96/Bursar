#!/usr/bin/env python3
"""Writes web/contracts/builds.json: the code hash (sha256, base58, as the RPC's view_account reports it) of every
bursar_policy.wasm ever committed plus the current file. The explorer and the login page only trust a treasury whose
code hash is in this list: a registry entry can point anywhere, the code hash says whether it is a Bursar policy contract."""
import hashlib, json, os, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WASM = "web/contracts/bursar_policy.wasm"
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(b):
    n = int.from_bytes(b, "big"); s = ""
    while n: n, r = divmod(n, 58); s = A[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s
builds = {}
revs = subprocess.run(["git", "log", "--format=%h %ad", "--date=short", "--", WASM], cwd=ROOT, capture_output=True, text=True).stdout.split("\n")
for line in reversed([l for l in revs if l.strip()]):
    rev, date = line.split()
    blob = subprocess.run(["git", "show", f"{rev}:{WASM}"], cwd=ROOT, capture_output=True).stdout
    if blob: builds[b58(hashlib.sha256(blob).digest())] = f"{date} {rev}"
with open(os.path.join(ROOT, WASM), "rb") as f: builds[b58(hashlib.sha256(f.read()).digest())] = "current"
out = os.path.join(ROOT, "web/contracts/builds.json")
json.dump(builds, open(out, "w"), indent=1); print(f"{len(builds)} builds -> {out}")
# the same list as a script, for pages opened as files (fetch cannot read a local JSON; a script tag can)
js = os.path.join(ROOT, "web/contracts/builds.js")
open(js, "w").write("window.BURSAR_BUILDS = " + json.dumps(builds) + ";\n"); print(f"{len(builds)} builds -> {js}")
# the wasm itself as a script, for the console opened as a file (the creation wizard fetches it; fetch refuses file URLs)
import base64
wjs = os.path.join(ROOT, "web/contracts/bursar_policy.wasm.js")
with open(os.path.join(ROOT, WASM), "rb") as f: open(wjs, "w").write("window.BURSAR_POLICY_WASM = \"" + base64.b64encode(f.read()).decode() + "\";\n")
print(f"wasm as script -> {wjs}")
