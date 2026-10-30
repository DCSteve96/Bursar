#!/usr/bin/env python3
# Writes the Content-Security-Policy meta of console.html and login.html. Run it after editing those pages. Idempotent.
#
# Why the policy is small: both pages sign in through NEAR Connect, which runs each wallet's code in an iframe filled
# with `srcdoc`. Such an iframe inherits the page's policy, so a script-src with hashes (what the third audit put here)
# blocked every non-extension wallet ("Wallet executor did not initialize within 5s"). The policy therefore leaves
# scripts alone and keeps what cannot hurt the wallets: no plugins, no <base> hijack, no form posts elsewhere.
# The CDN modules the pages load carry `integrity` hashes in the import map instead.
import re, sys, pathlib
HERE = pathlib.Path(__file__).resolve().parent
POLICY = "object-src 'none'; base-uri 'self'; form-action 'self'"
for name in sys.argv[1:] or ["console.html", "login.html"]:
    p = HERE / name; s = p.read_text()
    meta = f'<meta http-equiv="Content-Security-Policy" content="{POLICY}">'
    s2 = re.sub(r'<meta http-equiv="Content-Security-Policy" content="[^"]*">\n?', "", s)
    s2 = s2.replace('<meta name="viewport"', meta + '\n<meta name="viewport"', 1)
    p.write_text(s2); print(name, "policy written")
