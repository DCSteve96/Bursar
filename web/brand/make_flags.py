"""Builds brand/flags.png: one vertical sprite of the country flags used by the console.

Each tile is 44x32 (shown at 22x16), cropped to cover like object-fit: cover.
Source images come from flagcdn.com at build time only; the console never
loads anything from a third party at run time.

  python3 web/brand/make_flags.py            # reads the COUNTRIES list from web/app.html
"""
import io, pathlib, re, sys, urllib.request
from PIL import Image

W, H = 44, 32
here = pathlib.Path(__file__).resolve().parent
app = (here.parent / "app.html").read_text()
codes = re.findall(r'\["([A-Z]{2})","[^"]+"\]', app.split("const COUNTRIES = ")[1].split("];")[0])
sprite = Image.new("RGBA", (W, H * len(codes)), (0, 0, 0, 0))
for i, code in enumerate(codes):
    raw = urllib.request.urlopen(f"https://flagcdn.com/w80/{code.lower()}.png", timeout=30).read()
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    scale = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    left, top = (im.width - W) // 2, (im.height - H) // 2
    sprite.paste(im.crop((left, top, left + W, top + H)), (0, i * H))
    print(code, end=" ", flush=True)
sprite.save(here / "flags.png", optimize=True)
print(f"\n{len(codes)} flags, {(here / 'flags.png').stat().st_size} bytes")
