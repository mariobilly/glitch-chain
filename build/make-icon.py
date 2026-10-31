"""Generates build/icon.png + build/icon.ico: a glitched 'G' on a dark CRT tile."""
import colorsys
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

S = 1024
OUT = Path(__file__).parent
random.seed(7)


def rounded_mask(size, r):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], r, fill=255)
    return m


# --- glyph layer -----------------------------------------------------------
font = None
for f in ("impact.ttf", "ariblk.ttf", "arialbd.ttf"):
    try:
        font = ImageFont.truetype(f"C:/Windows/Fonts/{f}", 820)
        break
    except OSError:
        pass
glyph = Image.new("L", (S, S), 0)
d = ImageDraw.Draw(glyph)
bbox = d.textbbox((0, 0), "G", font=font)
w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((S - w) / 2 - bbox[0], (S - h) / 2 - bbox[1]), "G", font=font, fill=255)

# --- background: deep gradient ---------------------------------------------
bg = Image.new("RGB", (S, S))
px = bg.load()
for y in range(S):
    t = y / S
    for x in range(S):
        v = (x - S / 2) ** 2 + (y - S * 0.45) ** 2
        glow = max(0.0, 1 - v / (S * 0.62) ** 2)
        px[x, y] = (int(14 + 40 * glow), int(10 + 8 * glow + 6 * t), int(22 + 30 * glow))

# --- chromatic split: red left, cyan right, white core ----------------------
def tinted(mask, color):
    layer = Image.new("RGB", (S, S), color)
    return Image.composite(layer, Image.new("RGB", (S, S), 0), mask)

red = tinted(ImageChops.offset(glyph, -26, 4), (255, 30, 70))
cyan = tinted(ImageChops.offset(glyph, 26, -4), (40, 240, 255))
core = tinted(glyph, (245, 245, 250))
img = ImageChops.add(bg, ImageChops.screen(red, cyan))
img = Image.composite(core, img, glyph.filter(ImageFilter.MinFilter(9)))

# --- stretch-tear bands with rainbow smear ---------------------------------
src = img.copy()
y = 250
while y < 820:
    bh = random.randint(14, 58)
    if random.random() < 0.45:
        shift = random.choice([-1, 1]) * random.randint(18, 60)
        band = src.crop((0, y, S, y + bh))
        img.paste(ImageChops.offset(band, shift, 0), (0, y))
        # pixel smear from a random edge to the right, hue-cycled
        edge = random.randint(360, 640)
        col = src.crop((edge, y, edge + 1, y + bh)).resize((S - edge, bh))
        hue0 = random.random()
        smear = Image.new("RGB", (S - edge, bh))
        sp = smear.load()
        cp = col.load()
        for sx in range(S - edge):
            r, g, b = colorsys.hsv_to_rgb((hue0 + sx / 380) % 1, 0.85, 1)
            fade = max(0.0, 1 - sx / (S - edge))
            for sy in range(bh):
                l = sum(cp[sx, sy]) / 765
                k = (0.25 + l) * fade
                sp[sx, sy] = (int(r * 255 * k), int(g * 255 * k), int(b * 255 * k))
        region = img.crop((edge, y, S, y + bh))
        img.paste(ImageChops.screen(region, smear), (edge, y))
    y += bh + random.randint(4, 40)

# --- scanlines + subtle RGB mask -------------------------------------------
scan = Image.new("L", (S, S), 255)
sd = ImageDraw.Draw(scan)
for yy in range(0, S, 8):
    sd.rectangle([0, yy + 5, S, yy + 7], fill=150)
img = ImageChops.multiply(img, Image.merge("RGB", (scan, scan, scan)))
img = ImageChops.add(img, img.filter(ImageFilter.GaussianBlur(18)), scale=2.2)

# --- rounded tile + thin rim -------------------------------------------------
tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
tile.paste(img, (0, 0), rounded_mask(S, 200))
rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(rim).rounded_rectangle([6, 6, S - 7, S - 7], 196, outline=(255, 42, 74, 180), width=10)
tile = Image.alpha_composite(tile, rim)

tile.save(OUT / "icon.png")
tile.save(OUT / "icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
print("wrote", OUT / "icon.ico")
