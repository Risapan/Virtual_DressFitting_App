import { PoseLandmarker, FilesetResolver } from "/static/vendor/mediapipe/vision_bundle.mjs";
import { Cloth } from "./cloth.js";
import { Renderer } from "./renderer.js";

// ---------------------------------------------------------------- constants
const LM = {
  nose: 0, lEye: 2, rEye: 5,
  lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lIdx: 19, rIdx: 20, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28,
};
const TORSO_PER_SHOULDER = 1.39;   // avg shoulder-joint -> hip-joint length / shoulder width
const NOSE_TO_ANKLE = 0.875;       // fraction of standing height
const BUST_PER_SHOULDER = 2.45;    // bust circumference / biacromial width
const HIP_PER_HIPJOINT = 3.7;      // hip circumference / hip-landmark distance
const GESTURE_HOLD_MS = 750;

// ---------------------------------------------------------------- dom
const $ = (s) => document.querySelector(s);
const video = $("#video");
const glCanvas = $("#gl");
const overlay = $("#overlay");
const octx = overlay.getContext("2d");

// ---------------------------------------------------------------- state
const state = {
  dresses: [], idx: 0, config: { currency: "Rs.", storeName: "My Boutique" },
  viewMode: "auto",            // auto | front | back
  facing: "front", facingVotes: 0, facingCandidate: "front",
  backW: 0,                    // 0 = front garment, 1 = back garment
  presence: 0, lastSeen: 0,
  dressFade: 0,
  tint: 1, tintTarget: 1,
  showSkeleton: false, armsOverlay: true,
  heightCm: Number(safeGet("vfm.height")) || 0,
  sizeSamples: [],
  gesture: { kind: null, start: 0, armed: true, cooldownUntil: 0 },
  capturing: false,
  ai: { installed: false },
  selToken: 0,
};

let renderer, landmarker;
const clothFront = new Cloth(), clothBack = new Cloth();
const garment = { front: null, back: null, dress: null };
let lastMask = null, lastLandmarks = null, lastVideoTime = -1, lastT = performance.now();
const filters = [];
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEMO_T = params.has("t") ? Number(params.get("t")) : null; // freeze demo time (seconds)
let demoCanvas = null;
let frameNo = 0;

// ---------------------------------------------------------------- boot
boot().catch((e) => fatal(e));

async function boot() {
  if (DEMO) {
    demoCanvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
    document.body.classList.add("demo");
  } else {
    setLoading("Starting camera…");
    await startCamera(safeGet("vfm.camera"));
    setLoading("Loading body tracker…");
    const fileset = await FilesetResolver.forVisionTasks("/static/vendor/mediapipe/wasm");
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/static/models/pose_landmarker_full.task", delegate: "GPU" },
      runningMode: "VIDEO", numPoses: 1, outputSegmentationMasks: true,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
  }
  renderer = new Renderer(glCanvas);

  setLoading("Loading collection…");
  const [dresses, config, status] = await Promise.all([
    fetch("/api/dresses").then((r) => r.json()),
    fetch("/api/config").then((r) => r.json()),
    fetch("/api/status").then((r) => r.json()).catch(() => ({ ai: {} })),
  ]);
  state.dresses = dresses;
  state.config = config;
  state.ai = status.ai || {};
  $("#brand").textContent = config.storeName;
  buildCarousel();
  if (dresses.length) await selectDress(Number(params.get("dress") ?? safeGet("vfm.idx")) || 0);
  else $("#empty").hidden = false;

  bindUI();
  updateHeightUI();
  $("#loading").hidden = true;
  // test hook: simulate N frames up front (headless screenshots render few frames)
  const warm = Number(params.get("warm") || 0);
  const t0 = performance.now();
  lastT = t0 - warm * 16.7;
  for (let i = warm; i > 0; i--) tick(t0 - i * 16.7);
  requestAnimationFrame(loop);
}

async function startCamera(deviceId) {
  if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
  const constraints = {
    audio: false,
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    if (deviceId) return startCamera(null);
    throw new Error("Camera access was blocked. Allow the camera for this page and reload.");
  }
  video.srcObject = stream;
  await video.play();
  await new Promise((r) => (video.videoWidth ? r() : video.addEventListener("loadedmetadata", r, { once: true })));
  lastVideoTime = -1;
}

// ---------------------------------------------------------------- catalog
function buildCarousel() {
  const list = $("#carousel");
  list.innerHTML = "";
  state.dresses.forEach((d, i) => {
    const b = document.createElement("button");
    b.className = "thumb";
    b.innerHTML = `<img alt="" src="${d.urls.thumb}"><span>${esc(d.name)}</span>`;
    b.onclick = () => selectDress(i);
    list.appendChild(b);
  });
}

async function selectDress(i) {
  const n = state.dresses.length;
  if (!n) return;
  state.idx = ((i % n) + n) % n;
  safeSet("vfm.idx", state.idx);
  const d = state.dresses[state.idx];
  const token = ++state.selToken;

  document.querySelectorAll(".thumb").forEach((t, k) => t.classList.toggle("active", k === state.idx));
  document.querySelectorAll(".thumb")[state.idx]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  $("#dress-name").textContent = d.name;
  $("#dress-price").textContent = d.price ? `${state.config.currency} ${Number(d.price).toLocaleString()}` : "";
  $("#dress-back-note").hidden = !!d.urls.back;
  updateSizeUI();

  const [fi, bi] = await Promise.all([loadImg(d.urls.front), d.urls.back ? loadImg(d.urls.back) : null]);
  if (token !== state.selToken) return;
  renderer.deleteTexture(garment.front?.tex);
  if (garment.back && garment.back.tex !== garment.front?.tex) renderer.deleteTexture(garment.back.tex);
  const ft = renderer.uploadImage(fi);
  garment.front = { tex: ft, img: fi };
  garment.back = bi ? { tex: renderer.uploadImage(bi), img: bi } : { tex: ft, img: fi };
  garment.dress = d;
  clothFront.setGarment(fi.width, fi.height, d.calib);
  clothBack.setGarment(garment.back.img.width, garment.back.img.height, d.calibBack || d.calib);
  state.dressFade = 0;
}

function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("could not load " + src));
    im.src = src;
  });
}

// ---------------------------------------------------------------- main loop
function loop(now) {
  requestAnimationFrame(loop);
  tick(now);
}

function tick(now) {
  if (!DEMO && video.readyState < 2) return;
  const dt = clamp((now - lastT) / 1000, 0, 0.1);
  lastT = now;
  const src = DEMO ? demoCanvas : video;
  const W = DEMO ? src.width : video.videoWidth, H = DEMO ? src.height : video.videoHeight;
  renderer.resize(W, H);
  if (overlay.width !== W) { overlay.width = W; overlay.height = H; }

  if (DEMO) {
    lastLandmarks = demoFrame(demoCanvas, now);
  } else if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, now);
    if (lastMask && lastMask !== res.segmentationMasks?.[0]) { try { lastMask.close(); } catch {} }
    lastMask = res.segmentationMasks?.[0] || null;
    const raw = res.landmarks?.[0];
    lastLandmarks = raw ? smoothLandmarks(raw, W, H, now) : null;
    if (!raw) filters.length = 0;
  }
  if ((frameNo++ % 30) === 0) sampleTint(src);

  const L = lastLandmarks;
  const body = L ? bodyFrom(L, W, H) : null;
  if (body) {
    if (now - state.lastSeen > 600) { clothFront.ready = false; clothBack.ready = false; }
    state.lastSeen = now;
    updateFacing(L, body);
    if (garment.dress) {
      clothFront.computeTargets(body);
      clothBack.computeTargets(body);
      clothFront.update(dt);
      clothBack.update(dt);
    }
    if (!state.capturing) handleGestures(L, body, now);
    collectSize(L, body);
  }
  const visible = body && now - state.lastSeen < 300;
  state.presence = approach(state.presence, visible ? 1 : 0, dt * 4);
  state.dressFade = approach(state.dressFade, 1, dt * 3);
  const wantBack = state.viewMode === "back" || (state.viewMode === "auto" && state.facing === "back") ? 1 : 0;
  state.backW = approach(state.backW, wantBack, dt * 5);
  state.tint += (state.tintTarget - state.tint) * Math.min(dt * 2, 1);

  // ---- draw
  renderer.drawVideo(src);
  if (garment.dress) {
    const a = state.presence * state.dressFade;
    renderer.drawCloth(clothFront, garment.front.tex, a * (1 - state.backW), state.tint);
    renderer.drawCloth(clothBack, garment.back.tex, a * state.backW, state.tint);
    if (state.armsOverlay && body && a > 0.05) renderer.drawArms(lastMask, armSegments(L, body));
  }
  drawOverlay(L, body, now);
  if (params.has("debug")) document.body.dataset.debug = JSON.stringify({
    facing: state.facing, cand: state.facingCandidate, votes: state.facingVotes, backW: +state.backW.toFixed(2),
    presence: +state.presence.toFixed(2), fade: +state.dressFade.toFixed(2), tint: +state.tint.toFixed(2), frames: frameNo,
    ls: L && [L[LM.lSh].x|0, L[LM.rSh].x|0, +L[LM.nose].z.toFixed(2), L[LM.nose].v], sw: body && [body.swProj|0, body.torso|0],
  });

  $("#hint").classList.toggle("show", !body && !state.capturing);
  $("#facing").textContent = state.viewMode === "auto" ? `Auto · ${state.facing}` : state.viewMode;
}

// ---------------------------------------------------------------- pose math
function smoothLandmarks(raw, W, H, now) {
  return raw.map((p, i) => {
    let f = filters[i];
    if (!f) f = filters[i] = { x: new OneEuro(1.4, 0.012), y: new OneEuro(1.4, 0.012) };
    return {
      x: f.x.filter(p.x * W, now), y: f.y.filter(p.y * H, now),
      z: p.z, v: p.visibility ?? 1, nx: p.x, ny: p.y,
    };
  });
}

function bodyFrom(L, W, H) {
  const ls = L[LM.lSh], rs = L[LM.rSh];
  if (ls.v < 0.5 || rs.v < 0.5) return null;
  const S = [(ls.x + rs.x) / 2, (ls.y + rs.y) / 2];
  const shDist = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  const lh = L[LM.lHip], rh = L[LM.rHip];
  const hipsOk = lh.v > 0.4 && rh.v > 0.4 && lh.y < H * 1.02 && rh.y < H * 1.02;
  let Hm, torso;
  if (hipsOk) {
    Hm = [(lh.x + rh.x) / 2, (lh.y + rh.y) / 2];
    torso = Math.hypot(Hm[0] - S[0], Hm[1] - S[1]);
    if (torso < shDist * 0.6) return null; // implausible (bent over / detection glitch)
  } else {
    torso = Math.max(shDist, 1) * TORSO_PER_SHOULDER;
    Hm = [S[0], S[1] + torso];
  }
  const d = [(Hm[0] - S[0]) / torso, (Hm[1] - S[1]) / torso];
  const p = [d[1], -d[0]];
  const swProj = Math.abs((ls.x - rs.x) * p[0] + (ls.y - rs.y) * p[1]);
  const sw = Math.max(swProj, torso * 0.5);

  const lk = L[LM.lKn], rk = L[LM.rKn];
  let legDir = d, spread = 1;
  if (hipsOk && lk.v > 0.5 && rk.v > 0.5) {
    const K = [(lk.x + rk.x) / 2, (lk.y + rk.y) / 2];
    const kl = Math.hypot(K[0] - Hm[0], K[1] - Hm[1]) || 1;
    legDir = [(K[0] - Hm[0]) / kl, (K[1] - Hm[1]) / kl];
    const hipDist = Math.max(Math.hypot(lh.x - rh.x, lh.y - rh.y), sw * 0.4);
    spread = clamp(Math.hypot(lk.x - rk.x, lk.y - rk.y) / hipDist / 1.15, 1, 2);
  }
  return { S, H: Hm, d, sw, swProj, torso, legDir, spread, shDist, hipsOk };
}

function updateFacing(L, body) {
  const ls = L[LM.lSh], rs = L[LM.rSh], nose = L[LM.nose];
  // facing the camera, the person's LEFT shoulder is on the image RIGHT
  let back = 0;
  if (ls.x < rs.x) back += 1;
  if (nose.z > 0) back += 1;
  if (nose.v < 0.6) back += 0.5;
  if ((L[LM.lEye].v + L[LM.rEye].v) / 2 < 0.5) back += 0.5;
  let cand = back >= 1.5 ? "back" : "front";
  if (body.swProj < body.torso * 0.42) cand = state.facing === "back" ? "back" : "side";
  if (cand === state.facingCandidate) state.facingVotes++;
  else { state.facingCandidate = cand; state.facingVotes = 0; }
  if (state.facingVotes > 5) state.facing = cand;
}

function armSegments(L, body) {
  const d = garment.dress;
  const sleeves = d?.sleeves || "none";
  const start = sleeves === "none" ? 0.15 : sleeves === "short" ? 0.55 : 1;
  const t = body.torso, segs = [];
  for (const [sh, el, wr, ix] of [[LM.lSh, LM.lEl, LM.lWr, LM.lIdx], [LM.rSh, LM.rEl, LM.rWr, LM.rIdx]]) {
    const S = L[sh], E = L[el], Wr = L[wr], I = L[ix];
    if (E.v < 0.5) continue;
    if (start < 1) {
      const a = [S.x + (E.x - S.x) * start, S.y + (E.y - S.y) * start];
      segs.push([a[0], a[1], E.x, E.y, t * 0.12]);
    }
    if (Wr.v < 0.5) continue;
    if (sleeves !== "long") segs.push([E.x, E.y, Wr.x, Wr.y, t * 0.1]);
    const hx = I.v > 0.4 ? Wr.x + (I.x - Wr.x) * 1.4 : Wr.x + (Wr.x - E.x) * 0.35;
    const hy = I.v > 0.4 ? Wr.y + (I.y - Wr.y) * 1.4 : Wr.y + (Wr.y - E.y) * 0.35;
    segs.push([Wr.x, Wr.y, hx, hy, t * 0.11]);
  }
  return segs;
}

// ---------------------------------------------------------------- gestures
// raise RIGHT hand above head -> next, LEFT -> previous, BOTH -> photo
function handleGestures(L, body, now) {
  const g = state.gesture;
  const nose = L[LM.nose];
  const up = (w) => L[w].v > 0.6 && L[w].y < nose.y - body.torso * 0.05;
  const r = up(LM.rWr), l = up(LM.lWr);
  const kind = r && l ? "both" : r ? "next" : l ? "prev" : null;
  if (!kind) { g.kind = null; g.armed = true; return; }
  if (!g.armed || now < g.cooldownUntil) return;
  if (kind !== g.kind) { g.kind = kind; g.start = now; return; }
  const hold = kind === "both" ? GESTURE_HOLD_MS * 1.3 : GESTURE_HOLD_MS;
  if (now - g.start >= hold) {
    g.armed = false; g.kind = null; g.cooldownUntil = now + 900;
    if (kind === "next") selectDress(state.idx + 1);
    else if (kind === "prev") selectDress(state.idx - 1);
    else captureSequence();
  }
}

function drawOverlay(L, body, now) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!L) return;
  const g = state.gesture;
  if (g.kind && g.armed) {
    const hold = g.kind === "both" ? GESTURE_HOLD_MS * 1.3 : GESTURE_HOLD_MS;
    const prog = clamp((now - g.start) / hold, 0, 1);
    const wrists = g.kind === "both" ? [LM.lWr, LM.rWr] : [g.kind === "next" ? LM.rWr : LM.lWr];
    for (const w of wrists) {
      const p = L[w], r = Math.max(body ? body.torso * 0.22 : 40, 28);
      octx.lineWidth = r * 0.22;
      octx.strokeStyle = "rgba(255,255,255,.25)";
      octx.beginPath(); octx.arc(p.x, p.y, r, 0, Math.PI * 2); octx.stroke();
      octx.strokeStyle = "#f3d7a6";
      octx.beginPath(); octx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); octx.stroke();
    }
  }
  if (state.showSkeleton) {
    const pairs = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
    octx.lineWidth = 3; octx.strokeStyle = "rgba(120,220,255,.9)";
    for (const [a, b] of pairs) {
      if (L[a].v < 0.4 || L[b].v < 0.4) continue;
      octx.beginPath(); octx.moveTo(L[a].x, L[a].y); octx.lineTo(L[b].x, L[b].y); octx.stroke();
    }
    octx.fillStyle = "#fff";
    for (const p of L) if (p.v > 0.4) { octx.beginPath(); octx.arc(p.x, p.y, 4, 0, 7); octx.fill(); }
  }
}

// ---------------------------------------------------------------- sizing
function collectSize(L, body) {
  if (!state.heightCm || state.facing !== "front" || !body.hipsOk) return;
  const n = L[LM.nose], la = L[LM.lAn], ra = L[LM.rAn];
  if (n.v < 0.6 || la.v < 0.6 || ra.v < 0.6) return;
  const ank = [(la.x + ra.x) / 2, (la.y + ra.y) / 2];
  const statPx = Math.hypot(ank[0] - n.x, ank[1] - n.y);
  if (statPx < body.torso * 2.2) return; // not standing upright
  const cmPerPx = (state.heightCm * NOSE_TO_ANKLE) / statPx;
  const hipPx = Math.hypot(L[LM.lHip].x - L[LM.rHip].x, L[LM.lHip].y - L[LM.rHip].y);
  state.sizeSamples.push({ bust: body.shDist * cmPerPx * BUST_PER_SHOULDER, hip: hipPx * cmPerPx * HIP_PER_HIPJOINT });
  if (state.sizeSamples.length > 120) state.sizeSamples.shift();
  if (state.sizeSamples.length % 10 === 0) updateSizeUI();
}

function sizeEstimate() {
  const s = state.sizeSamples;
  if (s.length < 25) return null;
  return { bust: median(s.map((x) => x.bust)), hip: median(s.map((x) => x.hip)) };
}

function suggestSize(est, sizes) {
  let best = null, bestScore = Infinity;
  for (const [name, r] of Object.entries(sizes || {})) {
    const off = (v, [lo, hi]) => (v < lo ? lo - v : v > hi ? v - hi : 0);
    const score = off(est.bust, r.bust || [0, 999]) + off(est.hip, r.hip || [0, 999]);
    if (score < bestScore - 0.01 || (Math.abs(score - bestScore) < 0.01)) { best = name; bestScore = score; }
  }
  return best;
}

function updateSizeUI() {
  const el = $("#size");
  const d = state.dresses[state.idx];
  if (!state.heightCm) { el.innerHTML = `<span class="muted">Set your height for a size tip</span>`; return; }
  const est = sizeEstimate();
  if (!est) { el.innerHTML = `<span class="muted">Stand facing the mirror, full body in view…</span>`; return; }
  const s = d ? suggestSize(est, d.sizes) : null;
  el.innerHTML = `<b>Suggested size: ${s ?? "—"}</b><span class="muted">est. bust ${Math.round(est.bust)} cm · hip ${Math.round(est.hip)} cm (approx.)</span>`;
}

function updateHeightUI() {
  $("#height-val").textContent = state.heightCm ? `${state.heightCm} cm` : "not set";
  $("#height-input").value = state.heightCm || 160;
}

// ---------------------------------------------------------------- capture
async function captureSequence() {
  if (state.capturing || !garment.dress) return;
  state.capturing = true;
  const steps = [
    { label: "Face the mirror", view: "front" },
    { label: "Turn to your side", view: "side" },
    { label: "Now turn around", view: "back" },
  ];
  const shots = [];
  const cd = $("#countdown");
  try {
    for (const s of steps) {
      for (let n = 3; n >= 1; n--) {
        cd.innerHTML = `<small>${s.label}</small><b>${n}</b>`;
        cd.hidden = false;
        await sleep(1000);
      }
      cd.hidden = true;
      await nextFrame();
      shots.push({ view: s.view, look: grabComposite(), person: grabRawMirrored() });
      flash();
      await sleep(350);
    }
  } finally {
    cd.hidden = true;
    state.capturing = false;
  }
  const dress = garment.dress;
  fetch("/api/looks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dressId: dress.id, images: shots.map((s) => s.look) }),
  }).catch(() => {});
  openLook(dress, shots);
}

function grabComposite() {
  const c = document.createElement("canvas");
  c.width = glCanvas.width; c.height = glCanvas.height;
  const x = c.getContext("2d");
  x.translate(c.width, 0); x.scale(-1, 1);
  x.drawImage(glCanvas, 0, 0);
  return c.toDataURL("image/jpeg", 0.9);
}

function grabRawMirrored() {
  const src = DEMO ? demoCanvas : video;
  const c = document.createElement("canvas");
  c.width = DEMO ? src.width : video.videoWidth; c.height = DEMO ? src.height : video.videoHeight;
  const x = c.getContext("2d");
  x.translate(c.width, 0); x.scale(-1, 1);
  x.drawImage(src, 0, 0);
  return c.toDataURL("image/jpeg", 0.92);
}

function openLook(dress, shots) {
  const m = $("#look-modal");
  $("#look-title").textContent = dress.name;
  const grid = $("#look-grid");
  grid.innerHTML = "";
  for (const s of shots) {
    const fig = document.createElement("figure");
    fig.innerHTML = `<img alt="${s.view} view" src="${s.look}"><figcaption>${s.view}</figcaption>`;
    if (state.ai.installed) {
      const b = document.createElement("button");
      b.className = "btn small";
      b.textContent = "Make realistic (AI)";
      b.onclick = () => aiRender(fig, b, dress, s);
      fig.appendChild(b);
    }
    grid.appendChild(fig);
  }
  $("#look-ai-note").hidden = state.ai.installed;
  m.hidden = false;
}

async function aiRender(fig, btn, dress, shot) {
  btn.disabled = true;
  const t0 = performance.now();
  const tick = setInterval(() => (btn.textContent = `Rendering… ${((performance.now() - t0) / 1000).toFixed(0)} s`), 500);
  try {
    const r = await fetch("/api/tryon", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dressId: dress.id, person: shot.person, view: shot.view === "back" ? "back" : "front" }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const url = URL.createObjectURL(await r.blob());
    fig.querySelector("img").src = url;
    fig.querySelector("figcaption").textContent = `${shot.view} · AI (${r.headers.get("X-Seconds")} s)`;
    btn.remove();
  } catch (e) {
    btn.textContent = "Failed: " + e.message;
  } finally {
    clearInterval(tick);
  }
}

async function openRecentLooks() {
  const looks = await fetch("/api/looks").then((r) => r.json());
  const m = $("#look-modal");
  $("#look-title").textContent = "Recent looks";
  const grid = $("#look-grid");
  grid.innerHTML = looks.length ? "" : `<p class="muted">No looks captured yet. Raise both hands to take one.</p>`;
  for (const l of looks.slice(0, 12)) {
    const d = state.dresses.find((x) => x.id === l.dressId);
    const fig = document.createElement("figure");
    fig.innerHTML = `<img alt="" src="${l.images[0]}"><figcaption>${esc(d?.name || l.dressId)}</figcaption>`;
    grid.appendChild(fig);
  }
  $("#look-ai-note").hidden = true;
  m.hidden = false;
}

// ---------------------------------------------------------------- misc
function sampleTint(src) {
  const c = sampleTint.c || (sampleTint.c = Object.assign(document.createElement("canvas"), { width: 32, height: 18 }));
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(src, 0, 0, 32, 18);
  const px = x.getImageData(0, 0, 32, 18).data;
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  const lum = s / (px.length / 4) / 255;
  state.tintTarget = clamp(0.62 + 0.8 * lum, 0.75, 1.08);
}

function bindUI() {
  $("#prev").onclick = () => selectDress(state.idx - 1);
  $("#next").onclick = () => selectDress(state.idx + 1);
  $("#capture").onclick = captureSequence;
  $("#looks").onclick = openRecentLooks;
  $("#view-toggle").onclick = cycleView;
  $("#settings").onclick = openSettings;
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => (b.closest(".modal").hidden = true)));
  $("#height-input").oninput = (e) => ($("#height-preview").textContent = `${e.target.value} cm`);
  $("#height-save").onclick = () => {
    state.heightCm = Number($("#height-input").value);
    safeSet("vfm.height", state.heightCm);
    state.sizeSamples = [];
    updateHeightUI(); updateSizeUI();
  };
  $("#new-customer").onclick = () => {
    state.heightCm = 0; safeSet("vfm.height", "");
    state.sizeSamples = [];
    updateHeightUI(); updateSizeUI();
    $("#settings-modal").hidden = true;
  };
  $("#opt-skeleton").onchange = (e) => (state.showSkeleton = e.target.checked);
  $("#opt-arms").onchange = (e) => (state.armsOverlay = e.target.checked);
  $("#camera-select").onchange = async (e) => {
    safeSet("vfm.camera", e.target.value);
    await startCamera(e.target.value);
  };
  $("#fullscreen").onclick = () => document.documentElement.requestFullscreen?.();

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowRight") selectDress(state.idx + 1);
    else if (e.key === "ArrowLeft") selectDress(state.idx - 1);
    else if (e.key === " ") { e.preventDefault(); captureSequence(); }
    else if (e.key === "b") cycleView();
    else if (e.key === "d") { state.showSkeleton = !state.showSkeleton; $("#opt-skeleton").checked = state.showSkeleton; }
    else if (e.key === "f") document.documentElement.requestFullscreen?.();
    else if (e.key === "Escape") document.querySelectorAll(".modal").forEach((m) => (m.hidden = true));
  });
}

function cycleView() {
  state.viewMode = { auto: "front", front: "back", back: "auto" }[state.viewMode];
}

async function openSettings() {
  if (DEMO) { $("#settings-modal").hidden = false; return; }
  const sel = $("#camera-select");
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const cur = video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
  sel.innerHTML = cams.map((c, i) => `<option value="${c.deviceId}" ${c.deviceId === cur ? "selected" : ""}>${esc(c.label || "Camera " + (i + 1))}</option>`).join("");
  $("#height-preview").textContent = `${$("#height-input").value} cm`;
  $("#settings-modal").hidden = false;
}

function setLoading(t) { $("#loading-text").textContent = t; }
function fatal(e) {
  console.error(e);
  $("#loading").hidden = false;
  $("#loading-text").textContent = e.message || String(e);
  $("#loading").classList.add("error");
}
function flash() { const f = $("#flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nextFrame() { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }
function approach(v, t, s) { return v < t ? Math.min(v + s, t) : Math.max(v - s, t); }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = 0;
  }
  filter(x, tMs) {
    if (this.x === null) { this.x = x; this.t = tMs; return x; }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    const a = (c) => 1 / (1 + 1 / (2 * Math.PI * c * dt));
    const dx = (x - this.x) / dt;
    this.dx += a(this.dCutoff) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += a(cutoff) * (x - this.x);
    return this.x;
  }
}

// ---------------------------------------------------------------- demo mode
// A mannequin that sways, steps side to side and turns around, so the dress
// fit and physics can be checked without a camera (open /?demo).
function demoFrame(c, nowMs) {
  const t = DEMO_T ?? nowMs / 1000;
  const W = c.width, H = c.height, x = c.getContext("2d");
  // timeline (14 s loop): sway -> turn to back -> hold -> turn to front -> step
  const T = t % 14;
  let ang = 0;
  if (T > 3 && T < 6) ang = ease((T - 3) / 3) * Math.PI;
  else if (T >= 6 && T < 8) ang = Math.PI;
  else if (T >= 8 && T < 11) ang = Math.PI + ease((T - 8) / 3) * Math.PI;
  const walk = T >= 11 ? Math.sin(((T - 11) / 3) * Math.PI * 2) : 0;
  const cx = W / 2 + Math.sin(t * 0.9) * 26 + walk * 140;
  const sway = Math.sin(t * 1.7) * 0.05;
  const s = H / 620;                       // px per unit
  const top = 34 * s;
  // body model in local units (x: person's left = +, y: down, z: toward camera = -)
  const P = {
    nose: [0, 50, -24], lEye: [9, 40, -20], rEye: [-9, 40, -20],
    lSh: [54, 100, 0], rSh: [-54, 100, 0], lEl: [64, 190, 4], rEl: [-64, 190, 4],
    lWr: [66, 272, -4], rWr: [-66, 272, -4], lIdx: [66, 296, -6], rIdx: [-66, 296, -6],
    lHip: [30, 250, 0], rHip: [-30, 250, 0], lKn: [28, 375, -4], rKn: [-28, 375, -4],
    lAn: [26, 490, 4], rAn: [-26, 490, 4],
  };
  const step = Math.abs(walk) * 9;
  P.lKn[0] += step; P.lAn[0] += step * 1.6; P.rKn[0] -= step; P.rAn[0] -= step * 1.6;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const proj = ([lx, ly, lz]) => {
    const rx = lx * ca - lz * sa, rz = lx * sa + lz * ca;
    const tilt = sway * (ly - 250);       // lean around the hips
    return { x: cx + (rx + tilt) * s, y: top + ly * s, z: rz / 100, v: 0.99 };
  };
  const L = new Array(33).fill(null).map(() => ({ x: cx, y: H / 2, z: 0, v: 0 }));
  const facingAway = Math.cos(ang) < -0.2;
  for (const [k, v] of Object.entries(P)) {
    L[LM[k]] = proj(v);
    if (facingAway && (k === "nose" || k.endsWith("Eye"))) L[LM[k]].v = 0.3;
  }

  // ---- draw the "camera" frame: studio backdrop + mannequin
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#d9cfc6"); g.addColorStop(0.72, "#c4b6aa"); g.addColorStop(0.72, "#9c8b7e"); g.addColorStop(1, "#7f7064");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = "rgba(0,0,0,.18)";
  x.beginPath(); x.ellipse(cx, top + 500 * s, 90 * s, 14 * s, 0, 0, 7); x.fill();
  x.lineCap = "round"; x.lineJoin = "round";
  const skin = "#e8c9b0", skinD = "#d7b296";
  const limb = (a, b, w, col) => { x.strokeStyle = col; x.lineWidth = w * s; x.beginPath(); x.moveTo(L[a].x, L[a].y); x.lineTo(L[b].x, L[b].y); x.stroke(); };
  limb(LM.lHip, LM.lKn, 34, skinD); limb(LM.lKn, LM.lAn, 24, skinD);
  limb(LM.rHip, LM.rKn, 34, skinD); limb(LM.rKn, LM.rAn, 24, skinD);
  x.fillStyle = skin;
  x.beginPath();
  for (const k of [LM.lSh, LM.lHip, LM.rHip, LM.rSh]) x.lineTo(L[k].x, L[k].y);
  x.closePath(); x.fill(); x.strokeStyle = skin; x.lineWidth = 30 * s; x.stroke();
  const nk = proj([0, 70, 0]);
  x.lineWidth = 26 * s; x.beginPath(); x.moveTo(nk.x, nk.y); x.lineTo((L[LM.lSh].x + L[LM.rSh].x) / 2, L[LM.lSh].y + 4 * s); x.stroke();
  const hd = proj([0, 42, 0]);
  x.beginPath(); x.ellipse(hd.x, hd.y, 23 * s, 30 * s, 0, 0, 7); x.fill();
  x.fillStyle = "#3b2a22";
  x.beginPath(); x.ellipse(hd.x, hd.y - 8 * s, 25 * s, facingAway ? 32 * s : 24 * s, 0, Math.PI, facingAway ? Math.PI * 3 : Math.PI * 2); x.fill();
  limb(LM.lSh, LM.lEl, 24, skin); limb(LM.lEl, LM.lWr, 19, skin);
  limb(LM.rSh, LM.rEl, 24, skin); limb(LM.rEl, LM.rWr, 19, skin);
  return L;
}
function ease(u) { return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; }
