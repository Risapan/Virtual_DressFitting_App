"""Dress photo processing: background removal + automatic body calibration."""
from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

MAX_H = 1400


def _has_real_alpha(img: Image.Image) -> bool:
    if img.mode != "RGBA":
        return False
    a = np.asarray(img.getchannel("A"))
    return (a < 250).mean() > 0.02


def _rembg(img: Image.Image) -> Image.Image | None:
    try:
        from rembg import remove  # optional dependency
    except Exception:
        return None
    try:
        return remove(img).convert("RGBA")
    except Exception:
        return None


def _color_key(img: Image.Image) -> Image.Image:
    """Remove a plain background (white wall, sheet, etc.).

    Only background *connected to the photo border* is removed, so white
    polka dots or prints inside the dress survive.
    """
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(-1))
    # tolerance adapts to how noisy the border is
    tol = float(np.clip(np.percentile(np.sqrt(((border - bg) ** 2).sum(-1)), 90) * 1.6, 14, 60))

    # .copy(): fromarray shares the numpy buffer and floodfill silently no-ops on it
    cand = Image.fromarray(((dist < tol) * 255).astype(np.uint8), "L").copy()
    draw_seeds = [(x, 0) for x in range(0, w, 7)] + [(x, h - 1) for x in range(0, w, 7)] + \
                 [(0, y) for y in range(0, h, 7)] + [(w - 1, y) for y in range(0, h, 7)]
    for s in draw_seeds:
        if cand.getpixel(s) == 255:
            ImageDraw.floodfill(cand, s, 128)
    bgmask = np.asarray(cand) == 128

    # soft edge: fade pixels that are close to bg colour near the boundary
    soft = np.clip((dist - tol * 0.6) / (tol * 0.8), 0, 1)
    alpha = np.where(bgmask, 0.0, 1.0)
    edge = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    alpha = np.asarray(edge, dtype=np.float32) / 255.0
    near = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5))) < 128
    alpha = np.where(near & (alpha > 0), np.maximum(alpha * soft, 0), alpha)
    a_img = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    out = img.convert("RGBA")
    out.putalpha(a_img)
    return out


def cutout(data: bytes) -> tuple[Image.Image, str]:
    """Return (RGBA image cropped to the garment, method used)."""
    img = Image.open(io.BytesIO(data))
    img = img.convert("RGBA") if img.mode in ("RGBA", "LA", "P") else img.convert("RGB")
    if max(img.size) > 2400:
        img.thumbnail((2400, 2400), Image.LANCZOS)

    if _has_real_alpha(img):
        out, method = img, "existing-transparency"
    else:
        out = _rembg(img)
        method = "rembg"
        if out is None:
            out, method = _color_key(img), "plain-background"

    bbox = out.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    if bbox:
        pad = 6
        l, t, r, b = bbox
        out = out.crop((max(l - pad, 0), max(t - pad, 0), min(r + pad, out.width), min(b + pad, out.height)))
    if out.height > MAX_H:
        out = out.resize((round(out.width * MAX_H / out.height), MAX_H), Image.LANCZOS)
    return out, method


def auto_calibrate(img: Image.Image) -> dict:
    """Guess where the wearer's shoulder joints and hips sit on the garment image.

    Heuristic: the widest part of the top ~18% of the garment is the bust/shoulder
    area; shoulder joints sit slightly wider than that, and the hip joints sit
    ~1.39 shoulder-widths below the shoulders (average human proportion).
    """
    a = np.asarray(img.getchannel("A")) > 128
    h, w = a.shape
    rows = np.where(a.any(1))[0]
    if len(rows) == 0:
        return {"shoulderY": 0.05, "shoulderL": 0.25, "shoulderR": 0.75, "hipY": 0.4}
    top, bot = rows[0], rows[-1]
    gh = bot - top
    best_w, best_c = 0, w / 2
    for y in range(top, top + max(int(gh * 0.18), 2)):
        xs = np.where(a[y])[0]
        if len(xs) and xs[-1] - xs[0] > best_w:
            best_w, best_c = xs[-1] - xs[0], (xs[-1] + xs[0]) / 2
    sw = best_w * 1.05
    sy = top + gh * 0.012
    hy = min(sy + sw * 1.39, bot)
    return {
        "shoulderY": round(sy / h, 4),
        "shoulderL": round((best_c - sw / 2) / w, 4),
        "shoulderR": round((best_c + sw / 2) / w, 4),
        "hipY": round(hy / h, 4),
    }


def thumbnail(img: Image.Image) -> Image.Image:
    t = img.copy()
    t.thumbnail((240, 480), Image.LANCZOS)
    return t
