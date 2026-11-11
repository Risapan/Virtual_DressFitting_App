"""Virtual Fitting Mirror - local server.

Everything runs on this machine: the camera feed never leaves the browser
(pose tracking runs in-browser via MediaPipe), and the catalog lives in ./data.
"""
from __future__ import annotations

import base64
import io
import json
import re
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import imaging

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DRESSES = DATA / "dresses"
LOOKS = DATA / "looks"
CONFIG = DATA / "config.json"
for p in (DRESSES, LOOKS):
    p.mkdir(parents=True, exist_ok=True)

DEFAULT_CONFIG = {"storeName": "My Boutique", "currency": "Rs."}
DEFAULT_SIZES = {
    "XS": {"bust": [76, 81], "hip": [82, 87]},
    "S": {"bust": [81, 86], "hip": [87, 92]},
    "M": {"bust": [86, 92], "hip": [92, 98]},
    "L": {"bust": [92, 99], "hip": [98, 105]},
    "XL": {"bust": [99, 107], "hip": [105, 113]},
}
SLEEVES = {"none", "short", "long"}

app = FastAPI(title="Virtual Fitting Mirror")


# ---------- helpers ----------
def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "dress"
    base, i = s, 2
    while (DRESSES / s).exists():
        s, i = f"{base}-{i}", i + 1
    return s


def _dress_dir(dress_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]+", dress_id):
        raise HTTPException(400, "bad id")
    d = DRESSES / dress_id
    if not (d / "meta.json").exists():
        raise HTTPException(404, "dress not found")
    return d


def _read_meta(d: Path) -> dict:
    m = json.loads((d / "meta.json").read_text())
    m.setdefault("sizes", DEFAULT_SIZES)
    m.setdefault("sleeves", "none")
    m.setdefault("created", (d / "meta.json").stat().st_mtime)
    v = int((d / "meta.json").stat().st_mtime)
    base = f"/dresses/{d.name}/"
    m["urls"] = {
        "front": f"{base}{m['front']}?v={v}",
        "back": f"{base}{m['back']}?v={v}" if m.get("back") else None,
        "thumb": f"{base}{m.get('thumb', m['front'])}?v={v}",
    }
    return m


def _write_meta(d: Path, meta: dict) -> None:
    meta = {k: v for k, v in meta.items() if k != "urls"}
    (d / "meta.json").write_text(json.dumps(meta, indent=2))


def _config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG.exists():
        cfg.update(json.loads(CONFIG.read_text()))
    return cfg


# ---------- catalog ----------
@app.get("/api/dresses")
def list_dresses():
    items = [_read_meta(d) for d in DRESSES.iterdir() if (d / "meta.json").exists()]
    items.sort(key=lambda m: m.get("created", 0))
    return items


@app.post("/api/dresses")
async def add_dress(
    name: str = Form(...),
    price: float = Form(0),
    sleeves: str = Form("none"),
    front: UploadFile = File(...),
    back: UploadFile | None = File(None),
):
    if sleeves not in SLEEVES:
        raise HTTPException(400, "sleeves must be none/short/long")
    try:
        f_img, method = imaging.cutout(await front.read())
        b_img = None
        if back is not None and back.filename:
            b_img, _ = imaging.cutout(await back.read())
    except Exception as e:  # unreadable image
        raise HTTPException(400, f"could not read image: {e}")

    did = _slug(name)
    d = DRESSES / did
    d.mkdir(parents=True)
    f_img.save(d / "front.png")
    imaging.thumbnail(f_img).save(d / "thumb.png")
    meta = {
        "id": did, "name": name.strip(), "price": price, "sleeves": sleeves,
        "front": "front.png", "back": None, "thumb": "thumb.png",
        "calib": imaging.auto_calibrate(f_img), "sizes": DEFAULT_SIZES,
        "created": time.time(), "cutout": method,
    }
    if b_img is not None:
        b_img.save(d / "back.png")
        meta["back"] = "back.png"
        meta["calibBack"] = imaging.auto_calibrate(b_img)
    _write_meta(d, meta)
    return _read_meta(d)


class DressPatch(BaseModel):
    name: str | None = None
    price: float | None = None
    sleeves: str | None = None
    calib: dict | None = None
    calibBack: dict | None = None
    sizes: dict | None = None


@app.patch("/api/dresses/{dress_id}")
def update_dress(dress_id: str, patch: DressPatch):
    d = _dress_dir(dress_id)
    meta = _read_meta(d)
    upd = patch.model_dump(exclude_none=True)
    if "sleeves" in upd and upd["sleeves"] not in SLEEVES:
        raise HTTPException(400, "sleeves must be none/short/long")
    for key in ("calib", "calibBack"):
        if key in upd:
            c = upd[key]
            if not all(isinstance(c.get(k), (int, float)) for k in ("shoulderY", "shoulderL", "shoulderR", "hipY")):
                raise HTTPException(400, f"{key} needs shoulderY/shoulderL/shoulderR/hipY")
    meta.update(upd)
    _write_meta(d, meta)
    return _read_meta(d)


@app.delete("/api/dresses/{dress_id}")
def delete_dress(dress_id: str):
    shutil.rmtree(_dress_dir(dress_id))
    return {"ok": True}


@app.post("/api/dresses/{dress_id}/recalibrate")
def recalibrate(dress_id: str):
    d = _dress_dir(dress_id)
    meta = _read_meta(d)
    from PIL import Image
    meta["calib"] = imaging.auto_calibrate(Image.open(d / meta["front"]).convert("RGBA"))
    if meta.get("back"):
        meta["calibBack"] = imaging.auto_calibrate(Image.open(d / meta["back"]).convert("RGBA"))
    _write_meta(d, meta)
    return _read_meta(d)


# ---------- config ----------
@app.get("/api/config")
def get_config():
    return _config()


@app.put("/api/config")
def put_config(cfg: dict):
    merged = _config()
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    CONFIG.write_text(json.dumps(merged, indent=2))
    return merged


# ---------- looks (captured snapshots) ----------
class LookIn(BaseModel):
    dressId: str
    images: list[str]  # data URLs (jpeg/png)


def _decode_data_url(s: str) -> bytes:
    m = re.match(r"data:image/(png|jpeg);base64,(.+)", s, re.S)
    if not m:
        raise HTTPException(400, "images must be data URLs")
    return base64.b64decode(m.group(2))


@app.post("/api/looks")
def save_look(look: LookIn):
    if len(look.images) > 6:
        raise HTTPException(400, "too many images")
    lid = time.strftime("%Y%m%d-%H%M%S")
    d = LOOKS / lid
    d.mkdir(parents=True, exist_ok=True)
    names = []
    for i, s in enumerate(look.images):
        raw = _decode_data_url(s)
        n = f"{i + 1}.jpg"
        (d / n).write_bytes(raw)
        names.append(f"/looks/{lid}/{n}")
    (d / "meta.json").write_text(json.dumps({"dressId": look.dressId, "time": time.time()}))
    return {"id": lid, "images": names}


@app.get("/api/looks")
def list_looks():
    out = []
    for d in sorted(LOOKS.iterdir(), reverse=True):
        if not (d / "meta.json").exists():
            continue
        meta = json.loads((d / "meta.json").read_text())
        meta["id"] = d.name
        meta["images"] = [f"/looks/{d.name}/{p.name}" for p in sorted(d.glob("*.jpg"))]
        out.append(meta)
    return out[:60]


# ---------- optional AI photo try-on ----------
_engine = None
_engine_err = None


def _get_engine():
    global _engine, _engine_err
    if _engine is None and _engine_err is None:
        try:
            import tryon_engine
            _engine = tryon_engine.load()
        except Exception as e:
            _engine_err = str(e)
    return _engine


@app.get("/api/status")
def status():
    try:
        import tryon_engine
        installed = tryon_engine.installed()
    except Exception:
        installed = False
    return {"ai": {"installed": installed, "loaded": _engine is not None, "error": _engine_err}}


class TryOnIn(BaseModel):
    dressId: str
    person: str  # data URL of the raw camera frame
    view: str = "front"
    steps: int = 30


@app.post("/api/tryon")
def ai_tryon(req: TryOnIn):
    from PIL import Image
    eng = _get_engine()
    if eng is None:
        raise HTTPException(503, _engine_err or "AI try-on is not set up yet (see README)")
    d = _dress_dir(req.dressId)
    meta = _read_meta(d)
    garment_file = meta["back"] if req.view == "back" and meta.get("back") else meta["front"]
    garment = Image.open(d / garment_file).convert("RGBA")
    person = Image.open(io.BytesIO(_decode_data_url(req.person))).convert("RGB")
    t0 = time.time()
    result = eng.run(person, garment, steps=max(10, min(req.steps, 50)))
    buf = io.BytesIO()
    result.save(buf, "JPEG", quality=92)
    return Response(buf.getvalue(), media_type="image/jpeg",
                    headers={"X-Seconds": f"{time.time() - t0:.1f}"})


# ---------- static ----------
app.mount("/dresses", StaticFiles(directory=DRESSES), name="dresses")
app.mount("/looks", StaticFiles(directory=LOOKS), name="looks")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/admin")
def admin():
    return FileResponse(ROOT / "static" / "admin.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8790)
