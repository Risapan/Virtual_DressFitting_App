"""Generate three sample dresses (front + back PNGs with transparency) so the
mirror works before you photograph real stock.

Design space is 400 x 800 units with body landmarks at:
  shoulder joints  y=45,  x=110 / 290
  hip joints       y=295
which matches the calibration written to meta.json.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "dresses"
W, H = 400, 800          # design units
SCALE = 1.5               # output = 600 x 1200
SS = 3                    # supersampling for smooth edges


def mirror(half):
    """half = right-half points from top-centre clockwise to bottom-centre."""
    left = [(W - x, y) for x, y in reversed(half)]
    return half + left


def render(poly, base, accent, pattern=None, skirt_from=300, zipper=False, belt=None):
    fw, fh = int(W * SCALE * SS), int(H * SCALE * SS)
    k = SCALE * SS
    mask_img = Image.new("L", (fw, fh), 0)
    ImageDraw.Draw(mask_img).polygon([(x * k, y * k) for x, y in poly], fill=255)
    mask = np.asarray(mask_img, dtype=np.float32) / 255.0

    yy, xx = np.mgrid[0:fh, 0:fw].astype(np.float32)
    uy, ux = yy / k, xx / k  # back to design units

    # per-row half-width -> roundness shading
    cols = mask > 0.5
    left = np.where(cols.any(1), cols.argmax(1), 0).astype(np.float32)
    right = np.where(cols.any(1), fw - 1 - cols[:, ::-1].argmax(1), 0).astype(np.float32)
    cx = (left + right) / 2
    half = np.maximum((right - left) / 2, 1)
    rel = (xx - cx[:, None]) / half[:, None]
    shade = 1.0 - 0.28 * np.clip(rel, -1, 1) ** 4

    # vertical fabric folds in the skirt
    depth = np.clip((uy - skirt_from) / 300, 0, 1)
    folds = 1.0 - 0.10 * depth * (0.5 + 0.5 * np.sin(rel * math.pi * 5.5 + uy * 0.004))
    # soft top-light gradient
    light = 1.05 - 0.15 * (uy / H)

    base = np.array(base, np.float32)
    accent = np.array(accent, np.float32)
    col = np.broadcast_to(base, (fh, fw, 3)).copy()

    if pattern == "dots":
        gx = np.mod(ux + (np.floor(uy / 22) % 2) * 11, 22) - 11
        gy = np.mod(uy, 22) - 11
        d = np.clip(1.6 - (np.sqrt(gx * gx + gy * gy) - 3.2), 0, 1)[..., None]
        col = col * (1 - d) + accent * d
    elif pattern == "floral":
        for (ox, oy, s) in [(0, 0, 34), (17, 19, 34)]:
            gx = np.mod(ux + ox, s) - s / 2
            gy = np.mod(uy + oy, s) - s / 2
            r = np.sqrt(gx * gx + gy * gy)
            ang = np.arctan2(gy, gx)
            petal = 5.5 + 2.2 * np.cos(ang * 5)
            d = np.clip(1.5 - (r - petal), 0, 1)[..., None]
            centre = np.clip(1.5 - (r - 1.8), 0, 1)[..., None]
            col = col * (1 - d) + accent * d
            col = col * (1 - centre) + np.array([250, 214, 120], np.float32) * centre
    elif pattern == "sheen":
        s = 0.5 + 0.5 * np.sin(rel * 2.2 + uy * 0.01)
        col = col * (0.9 + 0.2 * s[..., None])

    if belt:
        y0, y1, bc = belt
        b = ((uy > y0) & (uy < y1))[..., None]
        col = np.where(b, np.array(bc, np.float32), col)

    if zipper:
        z = ((np.abs(ux - W / 2) < 1.2) & (uy > 60) & (uy < skirt_from + 40))[..., None]
        col = np.where(z, col * 0.55, col)

    col *= (shade * folds * light)[..., None]
    rgba = np.dstack([np.clip(col, 0, 255), mask * 255]).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA").resize((int(W * SCALE), int(H * SCALE)), Image.LANCZOS)
    return img


DRESSES = [
    {
        "id": "rose-aline-midi",
        "name": "Rose A-Line Midi",
        "price": 6450,
        "sleeves": "none",
        "colors": ((214, 92, 120), (255, 236, 240)),
        "pattern": "dots",
        "front": [(200, 112), (226, 38), (252, 38), (258, 92), (276, 124), (286, 152),
                  (264, 205), (288, 290), (318, 450), (346, 618), (300, 628), (250, 634), (200, 636)],
        "back": [(200, 70), (226, 38), (252, 38), (258, 92), (276, 124), (286, 152),
                 (264, 205), (288, 290), (318, 450), (346, 618), (300, 628), (250, 634), (200, 636)],
        "skirt_from": 220,
    },
    {
        "id": "navy-floral-tea",
        "name": "Navy Floral Tea Dress",
        "price": 7900,
        "sleeves": "short",
        "colors": ((34, 48, 92), (236, 150, 170)),
        "pattern": "floral",
        "front": [(200, 98), (218, 34), (292, 46), (322, 104), (302, 130), (288, 124), (288, 160),
                  (266, 208), (290, 292), (312, 420), (330, 552), (280, 560), (200, 564)],
        "back": [(200, 44), (218, 34), (292, 46), (322, 104), (302, 130), (288, 124), (288, 160),
                 (266, 208), (290, 292), (312, 420), (330, 552), (280, 560), (200, 564)],
        "skirt_from": 220,
        "belt": (198, 214, (22, 30, 60)),
    },
    {
        "id": "emerald-maxi",
        "name": "Emerald Satin Maxi",
        "price": 11500,
        "sleeves": "none",
        "colors": ((18, 112, 84), (0, 0, 0)),
        "pattern": "sheen",
        "front": [(200, 130), (214, 30), (236, 28), (262, 110), (282, 140), (284, 160),
                  (262, 206), (286, 292), (304, 470), (334, 770), (280, 782), (200, 786)],
        "back": [(200, 175), (214, 30), (236, 28), (262, 110), (282, 140), (284, 160),
                 (262, 206), (286, 292), (304, 470), (334, 770), (280, 782), (200, 786)],
        "skirt_from": 300,
    },
]

DEFAULT_SIZES = {
    "XS": {"bust": [76, 81], "hip": [82, 87]},
    "S": {"bust": [81, 86], "hip": [87, 92]},
    "M": {"bust": [86, 92], "hip": [92, 98]},
    "L": {"bust": [92, 99], "hip": [98, 105]},
    "XL": {"bust": [99, 107], "hip": [105, 113]},
}


def main():
    force = "--force" in sys.argv
    for d in DRESSES:
        folder = OUT / d["id"]
        if folder.exists() and not force:
            print("skip (exists):", d["id"])
            continue
        folder.mkdir(parents=True, exist_ok=True)
        base, accent = d["colors"]
        kw = dict(pattern=d["pattern"], skirt_from=d["skirt_from"], belt=d.get("belt"))
        front = render(mirror(d["front"]), base, accent, **kw)
        back = render(mirror(d["back"]), base, accent, zipper=True, **kw)
        front.save(folder / "front.png")
        back.save(folder / "back.png")
        thumb = front.copy()
        thumb.thumbnail((240, 480))
        thumb.save(folder / "thumb.png")
        calib = {"shoulderY": 45 / H, "shoulderL": 110 / W, "shoulderR": 290 / W, "hipY": 295 / H}
        meta = {
            "id": d["id"], "name": d["name"], "price": d["price"], "sleeves": d["sleeves"],
            "front": "front.png", "back": "back.png", "thumb": "thumb.png",
            "calib": calib, "sizes": DEFAULT_SIZES, "sample": True,
        }
        (folder / "meta.json").write_text(json.dumps(meta, indent=2))
        print("made:", d["id"])


if __name__ == "__main__":
    main()
