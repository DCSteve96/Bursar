#!/usr/bin/env python3
# Writes the Content-Security-Policy meta of console.html and login.html with the sha256 of their inline scripts.
# Run it after every edit of those pages (the hash changes with the script). Idempotent.
import base64, hashlib, re, sys, pathlib
HERE = pathlib.Path(__file__).resolve().parent
POLICY = ("default-src 'self'; script-src 'self' {hashes} https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh; "
          "worker-src https://cdnjs.cloudflare.com blob:; connect-src https: wss: http://127.0.0.1:* http://localhost:* http://192.0.2.2:*; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
          "font-src https://fonts.gstatic.com; frame-src https:; object-src 'none'; base-uri 'self'; form-action 'self'")
for name in sys.argv[1:] or ["console.html", "login.html"]:
    p = HERE / name; s = p.read_text()
    scripts = re.findall(r"<script(?: type=\"(?:module|importmap)\")?>(.*?)</script>", s, re.S)
    hashes = " ".join("'sha256-" + base64.b64encode(hashlib.sha256(x.encode()).digest()).decode() + "'" for x in scripts)
    meta = f'<meta http-equiv="Content-Security-Policy" content="{POLICY.format(hashes=hashes)}">'
    s2 = re.sub(r'<meta http-equiv="Content-Security-Policy" content="[^"]*">\n?', "", s)
    s2 = s2.replace('<meta name="viewport"', meta + '\n<meta name="viewport"', 1)
    p.write_text(s2); print(name, len(scripts), "inline scripts hashed")
