"use strict";

// ============================================================
// Sounds
// ============================================================
const Sounds = (() => {
  const _buf = {};
  function _load(name, src, vol) {
    const a = new Audio(src);
    a.volume = vol;
    _buf[name] = a;
  }
  _load("click",  "sounds/click.mp3",  0.45);
  _load("place",  "sounds/place.mp3",  0.55);
  _load("select", "sounds/select.mp3", 0.56);
  return {
    play(name) {
      const src = _buf[name];
      if (!src) return;
      const clone = /** @type {HTMLAudioElement} */ (src.cloneNode());
      clone.volume = src.volume;
      clone.play().catch(() => {});
    }
  };
})();
window.Sounds = Sounds;

// Global button-click sound — capture phase catches all <button>s,
// including dynamically created ones (lobby list, modals, etc.)
document.addEventListener("click", e => {
  if (e.target.closest("button")) Sounds.play("click");
}, true);

// ============================================================
// Constants
// ============================================================
const CELL = 23;
const BOARD_W = 188;
const BOARD_H = 196;
const BOARD_OFFSET_X = 2;
const BOARD_OFFSET_Y = 2;

const HOTBAR_CANVAS_H = 40;
const HOTBAR_W = 144;
const HOTBAR_H = 33;
const HOTBAR_BORDER = 4;     // 4px Rand
const HOTBAR_GAP = 14;       // 14px zwischen Slots
const HOTBAR_SLOT_W = CELL;  // 23 — figure size

const BUDGET      = 40;
const STAR_BUDGET = 10;

// Fancy Graphics mode — toggled via Settings panel
// Board canvas renders at full native resolution (BOARD_W*scale × BOARD_H*scale).
// All draw calls use logical coordinates; boardCtx.scale(s,s) maps them to pixels.
// No CSS upscaling — canvas displays at its intrinsic pixel size.
let fancyGraphics  = true;
let fancyShadows   = true;    // sub-option: drop-shadow on every piece
let fancySway      = true;    // sub-option: pieces gently sway
let fancyHoverZoom = true;    // sub-option: hovered pieces grow slightly
let fancyGlow        = true;  // sub-option: selected pieces emit additive light
let fancyGlowMarkers = true;  // sub-sub-option: marker dots also glow
let pixelShadows     = false; // sub-sub-option: hard pixel shadows (shadowBlur=0)

// ── Blue-violet marker glow params ──────────────────────────────
const _bvdb = {
  coreR:  0.29,   // core gradient radius (× CELL)
  outerR: 0.92,   // outer bloom radius (× CELL)
  cA0:    0.83,   // core alpha: centre stop
  cA1:    0.52,   // core alpha: 0.25 stop
  cA2:    0.49,   // core alpha: 0.65 stop
  oA0:    0.66,   // outer alpha: inner stop
  oA1:    0.80,   // outer alpha: mid stop
  // centre highlight colour (c0)
  c0r: 205, c0g:  74, c0b:  76,
  // hot ring colour (c1)
  c1r: 126, c1g: 112, c1b: 115,
  // outer-core colour (c2)
  c2r: 194, c2g:   0, c2b:   0,
};

// ── Hover zoom animation state ───────────────────────────────
const HOVER_ZOOM_TARGET   = 1.06;   // subtle max scale
const HOVER_ZOOM_DURATION = 0.20;   // seconds for full in/out transition

// Board: each cell has its own progress so pieces animate independently.
// Key = "row,col", value = progress 0–1.
const _boardZoomMap    = new Map();
let   _boardZoomTarget = null;      // "row,col" of currently hovered piece (or null)
let   _boardZoomRAFId  = null;

// Hotbar: single slot at a time is fine (slots don't overlap during hover).
let hoverZoomHotbarSlot  = null;   // 0–3 hotbar slot being zoomed
let _hotbarZoomProgress  = 0.0;
let _hotbarZoomRAFId     = null;

// ── Shared sprite canvas for fancy-mode piece rendering ──────
// Pieces are pre-rendered at display resolution (CELL × scale px) with
// nearest-neighbour, then composited onto the board canvas with bilinear
// smoothing so that rotation/zoom transforms look anti-aliased.
let _spriteCanvas = null;
let _spriteCtx    = null;

function _getSpriteCanvas(size) {
  if (!_spriteCanvas) {
    _spriteCanvas = document.createElement("canvas");
    _spriteCtx    = _spriteCanvas.getContext("2d");
  }
  if (_spriteCanvas.width !== size || _spriteCanvas.height !== size) {
    _spriteCanvas.width  = size;
    _spriteCanvas.height = size;
  }
  return _spriteCtx;
}

// ── Pre-rendered marker canvases ─────────────────────────────
// Each marker is pre-rendered at CELL*scale pixels (nearest-neighbour) so the
// boardCtx can composite it with imageSmoothingEnabled=true for smooth shadows/glow.
let _markerCanvas    = null;
let _markerHitCanvas = null;

function _buildMarkerCanvases() {
  const size = Math.ceil(CELL * state.scale * _dpr());
  function buildOne(imgKey, existing) {
    const img = images[imgKey];
    if (!img) return existing;
    const cv = existing || document.createElement("canvas");
    cv.width  = size;
    cv.height = size;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, size, size);
    return cv;
  }
  _markerCanvas    = buildOne("images/marker.png",    _markerCanvas);
  _markerHitCanvas = buildOne("images/markerHit.png", _markerHitCanvas);
}

// ── Drag-Tilt setting + state ────────────────────────────────
let dragTilt = true;
let _dragTiltVX       = 0;      // smoothed horizontal velocity (px/s)
let _dragTiltLastX    = null;
let _dragTiltLastT    = null;
let _dragTiltDecayRAF = null;
const DRAG_TILT_MAX   = 16;     // degrees
const DRAG_TILT_SCALE = 0.048;  // px/s → degrees

// ── Drag canvas rendering ─────────────────────────────────────
// Current pointer position in client (CSS-pixel) coords, updated on every move.
let _dragClientX = 0;
let _dragClientY = 0;
// Full-screen overlay canvas for the dragged piece (so it isn't clipped to the board).
let _dragCanvas = null;
let _dragCtx    = null;

// ── Hover move-preview state (PH_PLAY: faint dots where hovered piece can go) ──
let _hoverPreviewCell  = null;   // {row, col} of the piece being previewed
let _hoverPreviewMoves = null;   // array of pseudo-move targets [{row,col,capture}, ...]

// ── Piece tooltip (shown during setup when hovering opponent special pieces) ──
let _tooltipEl    = null;   // lazily resolved DOM element
let _lastMouseX   = 0;
let _lastMouseY   = 0;
function _getTooltipEl() {
  if (!_tooltipEl) _tooltipEl = document.getElementById("piece-tooltip");
  return _tooltipEl;
}
function _showPieceTooltip(text, cx, cy) {
  const el = _getTooltipEl();
  if (!el) return;
  el.textContent = text;
  // Position: prefer right of cursor, flip left if near right edge
  const margin = 12;
  const vw = window.innerWidth;
  const left = (cx + margin + 220 < vw) ? cx + margin : cx - 220 - margin;
  el.style.left = left + "px";
  el.style.top  = (cy + 16) + "px";
  el.classList.remove("hidden");
}
function _hidePieceTooltip() {
  const el = _getTooltipEl();
  if (el) el.classList.add("hidden");
}

// ── Sway helpers ──────────────────────────────────────────────
// Deterministic per-cell noise so each piece has its own rhythm
function _posRand(r, c, seed) {
  const v = Math.sin(r * 127.1 + c * 311.7 + seed * 74.3) * 43758.5453;
  return v - Math.floor(v);
}
function getSwayAngle(r, c, t) {
  const speed = 1.0 + _posRand(r, c, 1) * 0.6; // 1.0–1.6 rad/s  (~2.5× faster)
  const phase = _posRand(r, c, 2) * Math.PI * 2;
  return Math.sin(t * speed + phase) * (2.5 * Math.PI / 180); // ±2.5°
}

let swayTime     = 0;
let swayRAFId    = null;
let swayLastTime = null;

function startSwayLoop() {
  if (swayRAFId !== null) return;
  swayLastTime = null;
  swayRAFId = requestAnimationFrame(function loop(now) {
    if (!fancySway || !fancyGraphics) { swayRAFId = null; swayLastTime = null; return; }
    if (swayLastTime !== null) swayTime += (now - swayLastTime) / 1000;
    swayLastTime = now;
    if (!state.animating) { drawBoard(); drawHotbarGlow(); drawHotbar(); }
    swayRAFId = requestAnimationFrame(loop);
  });
}

// Glow is static (no pulse) — startGlowLoop kept as no-op for toggle wiring compatibility.
function startGlowLoop() {}

// Colors per player: P1 = warm amber/gold, P2 = electric cyan-blue
function _glowColor(color) {
  return color === 0 ? [255, 195, 55] : [55, 185, 255];
}

// Draw a static additive light corona at (cx, cy) in logical board coordinates.
// Uses globalCompositeOperation="lighter": adds color to whatever is beneath,
// just like a real point light source illuminating its surroundings.
// All pieces glow subtly; kings glow a bit brighter.
function _drawPieceGlow(ctx, cx, cy, color, isKing, dim = 1.0) {
  const [r, g, b] = _glowColor(color);
  const K         = (isKing ? 1.2 : 1.0) * dim;
  const C         = CELL;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur  = 0;

  // ── Layer 1: Wide diffuse corona — illuminates surrounding board squares ──
  const outerR = C * 2.4 * K;
  const outerG = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
  outerG.addColorStop(0,    `rgba(${r},${g},${b},${0.055 * K})`);
  outerG.addColorStop(0.45, `rgba(${r},${g},${b},${0.025 * K})`);
  outerG.addColorStop(1,    `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = outerG;
  ctx.fillRect(cx - outerR, cy - outerR, outerR * 2, outerR * 2);

  // ── Layer 2: Mid corona — bright shoulder just around the piece ──
  const midR = C * 1.0 * K;
  const midG = ctx.createRadialGradient(cx, cy, 0, cx, cy, midR);
  midG.addColorStop(0,   `rgba(${r},${g},${b},${0.10 * K})`);
  midG.addColorStop(0.5, `rgba(${r},${g},${b},${0.05 * K})`);
  midG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = midG;
  ctx.fillRect(cx - midR, cy - midR, midR * 2, midR * 2);

  // ── Layer 3: Hot white core — the piece itself is the source ──
  const coreR = C * 0.48 * K;
  const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  coreG.addColorStop(0,   `rgba(255,255,255,${0.14 * K})`);
  coreG.addColorStop(0.4, `rgba(${r},${g},${b},${0.09 * K})`);
  coreG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = coreG;
  ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

  // ── Layer 4: Floor reflection — flat ellipse below the piece ──
  const fRX = C * 0.85 * K;
  const fRY = C * 0.20 * K;
  const fCY = cy + C * 0.56;
  ctx.save();
  ctx.translate(cx, fCY);
  ctx.scale(1, fRY / fRX);
  const floorG = ctx.createRadialGradient(0, 0, 0, 0, 0, fRX);
  floorG.addColorStop(0,   `rgba(${r},${g},${b},${0.08 * K})`);
  floorG.addColorStop(0.6, `rgba(${r},${g},${b},${0.03 * K})`);
  floorG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = floorG;
  ctx.fillRect(-fRX, -fRX, fRX * 2, fRX * 2);
  ctx.restore();

  // ── Layer 5: Wide haze — soft long tail, prevents abrupt outer edge ──
  const hazeR = C * 5.0 * K;
  const hazeG = ctx.createRadialGradient(cx, cy, C * 1.2 * K, cx, cy, hazeR);
  hazeG.addColorStop(0, `rgba(${r},${g},${b},${0.012 * K})`);
  hazeG.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = hazeG;
  ctx.fillRect(cx - hazeR, cy - hazeR, hazeR * 2, hazeR * 2);

  ctx.restore();
}

// Extra pulsing glow drawn ON TOP of the ambient glow for the selected piece.
// Intensity is ~3× the ambient so it clearly stands out.
function _drawSelectedPieceGlow(ctx, cx, cy, color, isKing, strength = 1) {
  const [r, g, b] = _glowColor(color);
  const K         = (isKing ? 1.2 : 1.0) * strength;
  const C         = CELL;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur  = 0;

  // Extra corona — 0.6× the ambient alphas so total selected = 1.6× others
  const outerR = C * 2.4 * K;
  const outerG = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
  outerG.addColorStop(0,    `rgba(${r},${g},${b},${0.033 *  K})`);
  outerG.addColorStop(0.45, `rgba(${r},${g},${b},${0.015 *  K})`);
  outerG.addColorStop(1,    `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = outerG;
  ctx.fillRect(cx - outerR, cy - outerR, outerR * 2, outerR * 2);

  const midR = C * 1.0 * K;
  const midG = ctx.createRadialGradient(cx, cy, 0, cx, cy, midR);
  midG.addColorStop(0,   `rgba(${r},${g},${b},${0.060 *  K})`);
  midG.addColorStop(0.5, `rgba(${r},${g},${b},${0.030 *  K})`);
  midG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = midG;
  ctx.fillRect(cx - midR, cy - midR, midR * 2, midR * 2);

  const coreR = C * 0.48 * K;
  const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  coreG.addColorStop(0,   `rgba(255,255,255,${0.084 *  K})`);
  coreG.addColorStop(0.4, `rgba(${r},${g},${b},${0.054 *  K})`);
  coreG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = coreG;
  ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

  const fRX = C * 0.85 * K;
  const fRY = C * 0.20 * K;
  const fCY = cy + C * 0.56;
  ctx.save();
  ctx.translate(cx, fCY);
  ctx.scale(1, fRY / fRX);
  const floorG = ctx.createRadialGradient(0, 0, 0, 0, 0, fRX);
  floorG.addColorStop(0,   `rgba(${r},${g},${b},${0.048 *  K})`);
  floorG.addColorStop(0.6, `rgba(${r},${g},${b},${0.018 *  K})`);
  floorG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = floorG;
  ctx.fillRect(-fRX, -fRX, fRX * 2, fRX * 2);
  ctx.restore();

  // ── Wide haze ──
  const hazeR = C * 5.0 * K;
  const hazeG = ctx.createRadialGradient(cx, cy, C * 1.2 * K, cx, cy, hazeR);
  hazeG.addColorStop(0, `rgba(${r},${g},${b},${0.010 *  K})`);
  hazeG.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = hazeG;
  ctx.fillRect(cx - hazeR, cy - hazeR, hazeR * 2, hazeR * 2);

  ctx.restore();
}

// Drag variant — tight bright core, very faint outer bloom.
function _drawDragPieceGlow(ctx, cx, cy, color, isKing) {
  const [r, g, b] = _glowColor(color);
  const K         = isKing ? 1.2 : 1.0;
  const C         = CELL;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur  = 0;

  // Outer corona — light bloom
  const outerR = C * 2.4 * K;
  const outerG = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
  outerG.addColorStop(0,    `rgba(${r},${g},${b},${0.030 *  K})`);
  outerG.addColorStop(0.45, `rgba(${r},${g},${b},${0.012 *  K})`);
  outerG.addColorStop(1,    `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = outerG;
  ctx.fillRect(cx - outerR, cy - outerR, outerR * 2, outerR * 2);

  // Mid corona — reduced
  const midR = C * 1.0 * K;
  const midG = ctx.createRadialGradient(cx, cy, 0, cx, cy, midR);
  midG.addColorStop(0,   `rgba(${r},${g},${b},${0.075 *  K})`);
  midG.addColorStop(0.5, `rgba(${r},${g},${b},${0.033 *  K})`);
  midG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = midG;
  ctx.fillRect(cx - midR, cy - midR, midR * 2, midR * 2);

  // Hot white core — punchy, clearly brighter than selected
  const coreR = C * 0.48 * K;
  const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  coreG.addColorStop(0,   `rgba(255,255,255,${0.525 *  K})`);
  coreG.addColorStop(0.35,`rgba(${r},${g},${b},${0.390 *  K})`);
  coreG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = coreG;
  ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

  // Floor reflection — subtle
  const fRX = C * 0.85 * K;
  const fRY = C * 0.20 * K;
  const fCY = cy + C * 0.56;
  ctx.save();
  ctx.translate(cx, fCY);
  ctx.scale(1, fRY / fRX);
  const floorG = ctx.createRadialGradient(0, 0, 0, 0, 0, fRX);
  floorG.addColorStop(0,   `rgba(${r},${g},${b},${0.060 *  K})`);
  floorG.addColorStop(0.6, `rgba(${r},${g},${b},${0.021 *  K})`);
  floorG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = floorG;
  ctx.fillRect(-fRX, -fRX, fRX * 2, fRX * 2);
  ctx.restore();

  // Wide haze
  const hazeR = C * 5.0 * K;
  const hazeG = ctx.createRadialGradient(cx, cy, C * 1.2 * K, cx, cy, hazeR);
  hazeG.addColorStop(0, `rgba(${r},${g},${b},${0.014 *  K})`);
  hazeG.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = hazeG;
  ctx.fillRect(cx - hazeR, cy - hazeR, hazeR * 2, hazeR * 2);

  ctx.restore();
}


// Marker glow — additive radial light for move dots (white) and capture dots (red).
// cx/cy is the centre of the CELL in logical board coords.
// pieceColor: 0 = orange piece beneath, 1 = blue piece, null = no piece
function _drawMarkerGlow(ctx, cx, cy, isCapture, pieceColor) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur  = 0;
  const C = CELL;

  if (isCapture) {
    // ── Red capture marker — shifts to blue-violet over orange pieces ──
    const overOrange = pieceColor === 0;
    // Core colours: red vs blue-violet (blue-violet uses _bvdb)
    const c0 = overOrange ? `${_bvdb.c0r},${_bvdb.c0g},${_bvdb.c0b}` : "255,195,195";
    const c1 = overOrange ? `${_bvdb.c1r},${_bvdb.c1g},${_bvdb.c1b}` : "220,  0,  0";
    const c2 = overOrange ? `${_bvdb.c2r},${_bvdb.c2g},${_bvdb.c2b}` : "160,  0,  0";
    const c3 = "120,  0,  0";  // edge fade
    const o0 = "200,  0,  0";  // bloom inner
    const o1 = "150,  0,  0";  // bloom mid
    const o2 = "100,  0,  0";  // bloom far
    const o3 = " 60,  0,  0";  // bloom edge

    const coreR = C * (overOrange ? _bvdb.coreR : 0.92);
    const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    coreG.addColorStop(0,    `rgba(${c0},${overOrange ? _bvdb.cA0 : 0.51})`);
    coreG.addColorStop(0.25, `rgba(${c1},${overOrange ? _bvdb.cA1 : 0.52})`);
    coreG.addColorStop(0.65, `rgba(${c2},${overOrange ? _bvdb.cA2 : 0.49})`);
    coreG.addColorStop(1,    `rgba(${c3},0)`);
    ctx.fillStyle = coreG;
    ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

    const outerR = C * (overOrange ? _bvdb.outerR : 0.75);
    const outerG = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
    outerG.addColorStop(0,    `rgba(${o0},${overOrange ? _bvdb.oA0 : 0.23})`);
    outerG.addColorStop(0.35, `rgba(${o1},${overOrange ? _bvdb.oA1 : 0.54})`);
    outerG.addColorStop(0.70, `rgba(${o2},0)`);
    outerG.addColorStop(1,    `rgba(${o3},0)`);
    ctx.fillStyle = outerG;
    ctx.fillRect(cx - outerR, cy - outerR, outerR * 2, outerR * 2);

  } else {
    // ── White move marker ────────────────────────────────────────
    const coreR = C * 0.40;
    const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    coreG.addColorStop(0,   "rgba(255,255,255,0.28)");
    coreG.addColorStop(0.5, "rgba(220,210,160,0.11)");
    coreG.addColorStop(1,   "rgba(200,190,120,0)");
    ctx.fillStyle = coreG;
    ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

    const outerR = C * 1.1;
    const outerG = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
    outerG.addColorStop(0,    "rgba(255,240,160,0.08)");
    outerG.addColorStop(0.55, "rgba(230,210,120,0.04)");
    outerG.addColorStop(1,    "rgba(200,180, 80,0)");
    ctx.fillStyle = outerG;
    ctx.fillRect(cx - outerR, cy - outerR, outerR * 2, outerR * 2);
  }

  ctx.restore();
}

// Hotbar variant — same layers but tighter
function _drawHotbarGlow(ctx, cx, cy, color) {
  const [r, g, b] = _glowColor(color);
  const C         = CELL;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur  = 0;

  const outerR = C * 1.8;
  const outerG = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
  outerG.addColorStop(0,   `rgba(${r},${g},${b},0.45)`);
  outerG.addColorStop(0.4, `rgba(${r},${g},${b},0.20)`);
  outerG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = outerG;
  ctx.fillRect(cx - outerR, cy - outerR, outerR * 2, outerR * 2);

  const coreR = C * 0.65;
  const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  coreG.addColorStop(0,   `rgba(255,255,255,0.80)`);
  coreG.addColorStop(0.35,`rgba(${r},${g},${b},0.55)`);
  coreG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = coreG;
  ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

  ctx.restore();
}

// Per-cell board zoom loop — each cell animates independently.
function _startBoardZoomLoop() {
  if (_boardZoomRAFId !== null) return;
  let lastTime = null;
  _boardZoomRAFId = requestAnimationFrame(function loop(now) {
    if (!fancyHoverZoom || !fancyGraphics) {
      _boardZoomMap.clear(); _boardZoomTarget = null; _boardZoomRAFId = null;
      if (!state.animating) drawBoard();
      return;
    }
    const dt   = lastTime !== null ? (now - lastTime) / 1000 : 0.016;
    lastTime   = now;
    const step = dt / HOVER_ZOOM_DURATION;

    // Tick every tracked cell: target → up, others → down (remove when done).
    for (const [key, prog] of _boardZoomMap) {
      const next = key === _boardZoomTarget
        ? Math.min(1.0, prog + step)
        : Math.max(0.0, prog - step);
      if (next <= 0 && key !== _boardZoomTarget) {
        _boardZoomMap.delete(key);
      } else {
        _boardZoomMap.set(key, next);
      }
    }

    if (!state.animating) drawBoard();

    // Keep running while any cell still has progress or a target exists.
    if (_boardZoomMap.size > 0 || _boardZoomTarget !== null) {
      _boardZoomRAFId = requestAnimationFrame(loop);
    } else {
      _boardZoomRAFId = null;
    }
  });
}

// Hotbar zoom loop — single shared progress for the one hovered slot.
function _startHotbarZoomLoop() {
  if (_hotbarZoomRAFId !== null) return;
  let lastTime = null;
  _hotbarZoomRAFId = requestAnimationFrame(function loop(now) {
    if (!fancyHoverZoom || !fancyGraphics) {
      _hotbarZoomProgress = 0; hoverZoomHotbarSlot = null; _hotbarZoomRAFId = null;
      if (!state.animating) drawHotbar();
      return;
    }
    const dt   = lastTime !== null ? (now - lastTime) / 1000 : 0.016;
    lastTime   = now;
    const step = dt / HOVER_ZOOM_DURATION;
    const hasTarget = hoverZoomHotbarSlot !== null;
    _hotbarZoomProgress = hasTarget
      ? Math.min(1.0, _hotbarZoomProgress + step)
      : Math.max(0.0, _hotbarZoomProgress - step);
    if (!state.animating) drawHotbar();
    if ((hasTarget && _hotbarZoomProgress < 1.0) || (!hasTarget && _hotbarZoomProgress > 0.0)) {
      _hotbarZoomRAFId = requestAnimationFrame(loop);
    } else {
      _hotbarZoomRAFId = null;
    }
  });
}

const PIECE_INFO = {
  "00": { name: "King",         cost: 0, skins: 1  },
  "01": { name: "Pawn",         cost: 1, skins: 10 },
  "02": { name: "Bishop",       cost: 3, skins: 5  },
  "03": { name: "Knight",       cost: 3, skins: 2  },
  "04": { name: "Rook",         cost: 5, skins: 1  },
  "05": { name: "Queen",        cost: 9, skins: 6  },
  "06": { name: "Double Pawn",  cost: 1, skins: 10 },
  "10": { name: "Blocker",      cost: 5, skins: 5  },
  "11": { name: "Sumo Wrestler",cost: 6, skins: 1  },
  "12": { name: "Acrobat",      cost: 3, skins: 1  },
  "20": { name: "Cannonball",   cost: 1, skins: 1  },
};

const HOTBAR_TYPES = ["01", "02", "03", "04", "05", "10", "11", "12", "20"];

const P1 = 0, P2 = 1;
const PH_KING_PLACE = "kingPlace";
const PH_SETUP      = "setup";
const PH_PLAY       = "play";
const PH_END        = "end";

const FLIP_DURATION_MS = 600;
const DRAG_THRESHOLD_PX = 5;
const PIECE_VISUAL_OFFSET_Y = -4;   // shift all rendered figures up by 4px
const CANNON_ANIM_MS = 1000;         // cannonball travel animation duration
const HOTBAR_INTERNAL_SCALE = 4;    // hotbar renders at 4x internal resolution
                                    // → selected scale 1.25 maps to clean 5x integer pixels

// 3x5 pixel digits for cost rendering (canvas-native pixelart)
const PIXEL_DIGITS = {
  "0": ["111","101","101","101","111"],
  "1": ["010","110","010","010","111"],
  "2": ["111","001","111","100","111"],
  "3": ["111","001","111","001","111"],
  "4": ["101","101","111","001","001"],
  "5": ["111","100","111","001","111"],
  "6": ["111","100","111","101","111"],
  "7": ["111","001","010","010","100"],
  "8": ["111","101","111","101","111"],
  "9": ["111","101","111","001","111"],
};

function drawPixelDigit(ctx, d, x, y, color, shadowColor) {
  const pat = PIXEL_DIGITS[d];
  if (!pat) return;
  if (shadowColor) {
    ctx.fillStyle = shadowColor;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (pat[r][c] === "1") ctx.fillRect(x + c, y + r + 1, 1, 1);
    }
  }
  ctx.fillStyle = color;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
    if (pat[r][c] === "1") ctx.fillRect(x + c, y + r, 1, 1);
  }
}

function drawPixelNumber(ctx, num, rightX, bottomY, color, shadowColor) {
  const str = String(num);
  const w = str.length * 3 + (str.length - 1);
  let x = rightX - w;
  const y = bottomY - 5;
  for (let i = 0; i < str.length; i++) {
    drawPixelDigit(ctx, str[i], x, y, color, shadowColor);
    x += 4;
  }
}

// ============================================================
// State
// ============================================================
const state = {
  phase: PH_KING_PLACE,
  current: P1,
  viewFlipped: false,
  board: createEmptyBoard(),
  budgets: [BUDGET, BUDGET],
  stars:   [STAR_BUDGET, STAR_BUDGET],
  hotbars: [[], []],
  selectedHotbarIdx: [null, null],
  selectedSquare: null,
  legalMoves: [],
  kingsPlaced: [false, false],
  setupDone:   [false, false],
  scale: 3,
  animating: false,
  flipAnim: null,
  cannonAnim: null,   // { fromX,fromY,toX,toY,toRow,toCol,startTime } during cannonball move
  message: "",
  winner: null,

  // Pointer / drag
  pointer: null,    // { source, payload, startX, startY, dragging, suppressClick }

  // Hover preview
  hoverCell: null,     // {row, col} of cell currently hovered (only when valid target)

  // Graveyards: captured[color] = list of pieces of THAT color that were captured
  captured: [[], []],

  // En passant target square after a pawn double-move, or null
  enPassant: null,

  // Online multiplayer — populated by online.js when active
  online: {
    active:       false,
    myColor:      null,   // 0 (P1/orange) | 1 (P2/cyan)
    opponentName: "",
  },
};

function createEmptyBoard() {
  const b = [];
  for (let r = 0; r < 8; r++) b.push(new Array(8).fill(null));
  return b;
}

function makePiece(color, type, skin = null) {
  if (skin === null) {
    const skins = PIECE_INFO[type].skins;
    skin = Math.floor(Math.random() * skins);
  }
  return { color, type, skin };
}

function pieceFile(p) {
  if (p.type === "20") return "images/figures/2000.png";
  return `images/figures/${p.color}${p.type}${p.skin}.png`;
}

// ============================================================
// Image loader
// ============================================================
const images = {};
function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (images[src]) return resolve(images[src]);
    const img = new Image();
    img.onload = () => { images[src] = img; resolve(img); };
    img.onerror = reject;
    img.src = src;
  });
}

async function preload() {
  const list = [
    "images/chessBoard.png",
    "images/hotbar.png",
    "images/marker.png",
    "images/markerHit.png",
    "images/coin.png",
  ];
  for (const t of Object.keys(PIECE_INFO)) {
    const skins = PIECE_INFO[t].skins;
    for (let s = 0; s < skins; s++) {
      list.push(`images/figures/0${t}${s}.png`);
      list.push(`images/figures/1${t}${s}.png`);
    }
  }
  // Cannonball animation frames (shared for both colors)
  for (let f = 0; f < 4; f++) list.push(`images/figures/200${f}.png`);
  await Promise.allSettled(list.map(loadImage));
  // Wait for the pixel font so canvas text uses it
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.load("8px 'Press Start 2P'"); } catch (e) {}
    try { await document.fonts.ready; } catch (e) {}
  }
}

// ============================================================
// Coordinate helpers
// ============================================================
function cellPos(row, col, flipped) {
  const dispRow = flipped ? row : 7 - row;
  const dispCol = flipped ? 7 - col : col;
  return {
    x: BOARD_OFFSET_X + dispCol * CELL,
    y: BOARD_OFFSET_Y + dispRow * CELL,
  };
}

function cellToCanvas(row, col) {
  return cellPos(row, col, state.viewFlipped);
}

function canvasToCell(x, y) {
  if (x < BOARD_OFFSET_X || y < BOARD_OFFSET_Y) return null;
  const dispCol = Math.floor((x - BOARD_OFFSET_X) / CELL);
  const dispRow = Math.floor((y - BOARD_OFFSET_Y) / CELL);
  if (dispCol < 0 || dispCol > 7 || dispRow < 0 || dispRow > 7) return null;
  let row, col;
  if (!state.viewFlipped) { row = 7 - dispRow; col = dispCol; }
  else                    { row = dispRow;     col = 7 - dispCol; }
  return { row, col };
}

function hotbarSlotX(idx) {
  // 4px border, then alternating slot(23) + gap(14)
  return HOTBAR_BORDER + idx * (HOTBAR_SLOT_W + HOTBAR_GAP);
}

function hotbarOriginInCanvas() {
  return {
    x: (BOARD_W - HOTBAR_W) / 2,
    y: (HOTBAR_CANVAS_H - HOTBAR_H) / 2,
  };
}

function hotbarPxToSlot(x, y) {
  const o = hotbarOriginInCanvas();
  const localX = x - o.x;
  const localY = y - o.y;
  if (localY < 0 || localY > HOTBAR_H) return null;
  for (let i = 0; i < 4; i++) {
    const sx = hotbarSlotX(i);
    if (localX >= sx && localX < sx + HOTBAR_SLOT_W) return i;
  }
  return null;
}

// ============================================================
// Placement validation
// ============================================================
function ownHalfRows(player) { return player === P1 ? [0, 1] : [6, 7]; }
function grundReihe(player)  { return player === P1 ? 0 : 7; }

function canPlaceKingAt(player, row, col) {
  if (row !== grundReihe(player)) return false;
  if (state.board[row][col] !== null) return false;
  return true;
}
function canPlacePieceAt(player, row, col) {
  const rows = ownHalfRows(player);
  if (!rows.includes(row)) return false;
  if (state.board[row][col] !== null) return false;
  return true;
}
function canAffordAny(player) {
  if (state.stars[player] <= 0) return false;
  const hotbar = state.hotbars[player];
  if (!hotbar || hotbar.length === 0) return false;
  let min = Infinity;
  for (const t of hotbar) {
    const info = PIECE_INFO[t];
    if (info && info.cost < min) min = info.cost;
  }
  if (min === Infinity) return false;
  return state.budgets[player] >= min;
}

function recomputeSetupDoneAfterPlacement(player) {
  if (!canAffordAny(player)) {
    state.setupDone[player] = true;
    state.selectedHotbarIdx[player] = null;
  }
}

// ============================================================
// Movement logic
// ============================================================
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function pawnDir(color) { return color === 0 ? +1 : -1; }

// Blocker (type "10") cannot be captured by any piece
function isBlocker(p) { return p && p.type === "10"; }

function pseudoMoves(board, row, col, enPassant = null) {
  const p = board[row][col];
  if (!p) return [];
  const moves = [];
  const push = (r, c, capture) => moves.push({ row: r, col: c, capture });

  switch (p.type) {
    case "00": {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr, nc = col + dc;
        if (!inBounds(nr, nc)) continue;
        const t = board[nr][nc];
        const straight = (dr === 0 || dc === 0);
        if (!t) push(nr, nc, false);
        else if (t.color !== p.color && !(isBlocker(t) && straight)) push(nr, nc, true);
      }
      break;
    }
    case "01": {
      const dir = pawnDir(p.color);
      const fr = row + dir;
      if (inBounds(fr, col) && !board[fr][col]) push(fr, col, false);
      const fr2 = row + 2 * dir;
      if (ownHalfRows(p.color).includes(row)
          && inBounds(fr, col) && !board[fr][col]
          && inBounds(fr2, col) && !board[fr2][col]) {
        moves.push({ row: fr2, col, capture: false, twoSquare: true });
      }
      for (const dc of [-1, 1]) {
        const nc = col + dc;
        if (!inBounds(fr, nc)) continue;
        const t = board[fr][nc];
        if (t && t.color !== p.color) push(fr, nc, true);
      }
      if (enPassant) {
        for (const dc of [-1, 1]) {
          if (fr === enPassant.row && col + dc === enPassant.col) {
            moves.push({ row: enPassant.row, col: enPassant.col, capture: true, isEnPassant: true });
          }
        }
      }
      break;
    }
    case "06": {
      const dir = pawnDir(p.color);
      const fr1 = row + dir, fr2 = row + 2 * dir;
      if (inBounds(fr1, col) && !board[fr1][col]) push(fr1, col, false);
      if (inBounds(fr1, col) && inBounds(fr2, col)
          && !board[fr1][col] && board[fr2][col]
          && board[fr2][col].color !== p.color) {
        push(fr2, col, true);
      }
      for (const dc of [-1, 1]) {
        const nc = col + dc;
        if (!inBounds(fr1, nc)) continue;
        const t = board[fr1][nc];
        if (t && t.color !== p.color) push(fr1, nc, true);
      }
      if (enPassant) {
        for (const dc of [-1, 1]) {
          if (fr1 === enPassant.row && col + dc === enPassant.col) {
            moves.push({ row: enPassant.row, col: enPassant.col, capture: true, isEnPassant: true });
          }
        }
      }
      break;
    }
    case "02": slide(board, row, col, p, [[1,1],[1,-1],[-1,1],[-1,-1]], push); break;
    case "03": {
      const deltas = [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]];
      for (const [dr, dc] of deltas) {
        const nr = row + dr, nc = col + dc;
        if (!inBounds(nr, nc)) continue;
        const t = board[nr][nc];
        if (!t) push(nr, nc, false);
        else if (t.color !== p.color) push(nr, nc, true);
      }
      break;
    }
    case "04": slide(board, row, col, p, [[1,0],[-1,0],[0,1],[0,-1]], push); break;
    case "05": slide(board, row, col, p, [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]], push); break;

    // ── Akrobat ("12"): Dame-Richtungen, muss über eine Figur springen, landet dahinter
    //    Die Plattform-Figur bleibt stehen; nur das Landefeld kann leer oder feindlich sein.
    case "12": {
      const dirs12 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [dr, dc] of dirs12) {
        let r = row + dr, c = col + dc;
        // Gleite über leere Felder bis zur Plattform
        while (inBounds(r, c) && !board[r][c]) { r += dr; c += dc; }
        if (!inBounds(r, c)) continue;          // kein Sprung möglich (Rand)
        // board[r][c] ist die Plattform — Landeplatz ist das Feld dahinter
        const lr = r + dr, lc = c + dc;
        if (!inBounds(lr, lc)) continue;        // hinter der Plattform kein Platz
        const landing = board[lr][lc];
        if (!landing)                                                push(lr, lc, false); // leer → Zug
        else if (landing.color !== p.color && landing.type !== "00") push(lr, lc, true);  // feindlich, kein König → Schlag
        // eigene Figur oder König → kein Zug
      }
      break;
    }

    // ── Blocker ("10"): Turm-Züge; schlägt NUR direkt angrenzende Feinde (1 Schritt)
    case "10": {
      // Bewegt sich wie ein König: 1 Schritt in alle 8 Richtungen
      const dirs10 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [dr, dc] of dirs10) {
        const r = row + dr, c = col + dc;
        if (!inBounds(r, c)) continue;
        const t = board[r][c];
        if (!t) push(r, c, false);
        else if (t.color !== p.color) push(r, c, true);
      }
      break;
    }

    // ── Kanonkugel ("20"): rollt vorwärts bis zum letzten freien Feld (oder schlägt erste Figur)
    case "20": {
      const dir20 = pawnDir(p.color);
      let r20 = row + dir20;
      let lastEmpty20 = null;
      while (inBounds(r20, col)) {
        const t = board[r20][col];
        if (t) {
          // Erste Figur: Schlag wenn Feind (und nicht Blocker-immun gegen gerade Angriffe)
          if (t.color !== p.color && !isBlocker(t)) push(r20, col, true);
          break;
        }
        lastEmpty20 = { row: r20, col };
        r20 += dir20;
      }
      // Muss bis zum letzten freien Feld rollen
      if (lastEmpty20) push(lastEmpty20.row, lastEmpty20.col, false);
      break;
    }

    // ── Sumoringer ("11"): 1-2 Felder gerade ODER 1 Feld diagonal
    //    Schlägt normal; schiebt automatisch die Figur ONE Feld hinter dem Ziel
    case "11": {
      // Hilfsfunktion: liefert Push-Info falls die Figur hinter dem Zielfeld wegschiebbar ist
      const sumoLand = (lr, lc, dr, dc, capture) => {
        const beyond = { r: lr + dr, c: lc + dc };
        if (inBounds(beyond.r, beyond.c) && board[beyond.r][beyond.c]) {
          const pushDest = { r: beyond.r + dr, c: beyond.c + dc };
          if (inBounds(pushDest.r, pushDest.c) && !board[pushDest.r][pushDest.c]) {
            return { row: lr, col: lc, capture,
                     isPush: true,
                     pushFromRow: beyond.r, pushFromCol: beyond.c,
                     pushToRow:   pushDest.r, pushToCol: pushDest.c };
          }
        }
        return { row: lr, col: lc, capture };
      };

      // 1 und 2 Felder gerade
      for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const r1 = row + dr, c1 = col + dc;
        if (!inBounds(r1, c1)) continue;
        const t1 = board[r1][c1];
        if (!t1) {
          moves.push(sumoLand(r1, c1, dr, dc, false));
          // 2 Felder (nur wenn 1. Feld frei)
          const r2 = row + 2*dr, c2 = col + 2*dc;
          if (inBounds(r2, c2)) {
            const t2 = board[r2][c2];
            if (!t2)                                              moves.push(sumoLand(r2, c2, dr, dc, false));
            else if (t2.color !== p.color && !isBlocker(t2))     moves.push(sumoLand(r2, c2, dr, dc, true));
          }
        } else if (t1.color !== p.color && !isBlocker(t1)) {
          moves.push(sumoLand(r1, c1, dr, dc, true));
        }
      }
      // 1 Feld diagonal
      for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nr = row + dr, nc = col + dc;
        if (!inBounds(nr, nc)) continue;
        const t = board[nr][nc];
        if (!t)                       moves.push(sumoLand(nr, nc, dr, dc, false));
        else if (t.color !== p.color) moves.push(sumoLand(nr, nc, dr, dc, true));
      }
      break;
    }
  }
  return moves;
}

function slide(board, row, col, p, dirs, push) {
  for (const [dr, dc] of dirs) {
    const straight = (dr === 0 || dc === 0);
    let r = row + dr, c = col + dc;
    while (inBounds(r, c)) {
      const t = board[r][c];
      if (!t) push(r, c, false);
      // Blocker: immun gegen gerade Angriffe, nicht gegen diagonale
      else { if (t.color !== p.color && !(isBlocker(t) && straight)) push(r, c, true); break; }
      r += dr; c += dc;
    }
  }
}

function findKing(board, color) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board[r][c];
    if (p && p.color === color && p.type === "00") return { row: r, col: c };
  }
  return null;
}

function isSquareAttacked(board, row, col, byColor) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board[r][c];
    if (!p || p.color !== byColor) continue;
    const moves = pseudoMoves(board, r, c);
    for (const m of moves) if (m.row === row && m.col === col) return true;
  }
  return false;
}

function isInCheck(board, color) {
  const k = findKing(board, color);
  if (!k) return false;
  return isSquareAttacked(board, k.row, k.col, 1 - color);
}

function cloneBoard(board) {
  return board.map(row => row.map(p => p ? { ...p } : null));
}

function applyMoveOnBoard(board, from, to, opts = {}) {
  const piece = board[from.row][from.col];
  const target = board[to.row][to.col];
  let movedPiece = { ...piece };

  // Sumoringer push: Figur HINTER dem Zielfeld wird weitergeschoben (Seiteneffekt)
  if (opts.isPush && opts.pushFromRow !== undefined) {
    board[opts.pushToRow][opts.pushToCol] = board[opts.pushFromRow][opts.pushFromCol];
    board[opts.pushFromRow][opts.pushFromCol] = null;
  }

  // Bauer schlägt Bauer → wird Doppelbauer, behält Skin-Index
  if (piece.type === "01" && target && target.type === "01") {
    movedPiece.type = "06";
    if (movedPiece.skin >= PIECE_INFO["06"].skins) {
      movedPiece.skin = movedPiece.skin % PIECE_INFO["06"].skins;
    }
  }
  board[to.row][to.col] = movedPiece;
  board[from.row][from.col] = null;

  // En passant: captured pawn is on the FROM row, destination column
  if (opts.isEnPassant) {
    const epPawn = board[from.row][to.col];
    if (epPawn && opts.recordCapture) state.captured[epPawn.color].push({ ...epPawn });
    board[from.row][to.col] = null;
    return { captured: epPawn };
  }
  if (target && opts.recordCapture) state.captured[target.color].push({ ...target });
  return { captured: target };
}

function legalMoves(board, row, col) {
  const p = board[row][col];
  if (!p) return [];
  const pseudo = pseudoMoves(board, row, col, state.enPassant);
  const result = [];
  for (const m of pseudo) {
    const sim = cloneBoard(board);
    applyMoveOnBoard(sim, { row, col }, { row: m.row, col: m.col }, {
      isEnPassant: m.isEnPassant,
      isPush: m.isPush, pushToRow: m.pushToRow, pushToCol: m.pushToCol,
    });
    if (!isInCheck(sim, p.color)) result.push(m);
  }
  return result;
}

function hasAnyLegalMove(board, color) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board[r][c];
    if (!p || p.color !== color) continue;
    if (legalMoves(board, r, c).length > 0) return true;
  }
  return false;
}

// ============================================================
// Rendering
// ============================================================
const boardCanvas = document.getElementById("board-canvas");
const boardCtx = boardCanvas.getContext("2d");
const hotbarCanvas     = document.getElementById("hotbar-canvas");
const hotbarCtx        = hotbarCanvas.getContext("2d");
const hotbarGlowCanvas = document.getElementById("hotbar-glow-canvas");
const hotbarGlowCtx    = hotbarGlowCanvas.getContext("2d");

function drawAll() {
  drawBoard();
  drawHotbarGlow();  // offscreen glow buffer first
  drawHotbar();      // pieces + composites glow on top
  drawHud();
  renderCapturedPieces();
}

// Track what we've already DOM-rendered to avoid re-creating images each frame
const _capturedRendered = [0, 0];

function renderCapturedPieces() {
  // Each piece icon is 52px + 4px gap = 56px per slot.
  // Board display height = BOARD_H * scale. Pieces per column = floor(boardPx / 56).
  const boardDisplayH = Math.round(BOARD_H * state.scale);
  const pieceSlotH    = 56; // 52px img + 4px gap
  const piecesPerCol  = Math.max(1, Math.floor(boardDisplayH / pieceSlotH));

  for (const color of [0, 1]) {
    const container = document.getElementById(color === 0 ? "captured-left" : "captured-right");
    if (!container) continue;
    const list = state.captured[color];
    // Reset case → wipe and re-render
    if (list.length < _capturedRendered[color]) {
      container.innerHTML = "";
      _capturedRendered[color] = 0;
    }
    // Update container height constraint so CSS wrapping kicks in at the right point
    container.style.maxHeight = boardDisplayH + "px";

    for (let i = _capturedRendered[color]; i < list.length; i++) {
      const p = list[i];
      const img = document.createElement("img");
      img.src = pieceFile(p);
      img.alt = "";
      if (p.type === "20") img.classList.add("captured-cannon");
      container.appendChild(img);
    }
    _capturedRendered[color] = list.length;
  }
}

function drawBoard() {
  // Draw at full native resolution (logical × scale × dpr).
  // boardCtx.scale(s*dpr, s*dpr) maps logical coordinates to physical pixels.
  const _s = state.scale * _dpr();
  boardCtx.setTransform(1, 0, 0, 1, 0, 0);
  boardCtx.scale(_s, _s);
  boardCtx.imageSmoothingEnabled = false; // nearest-neighbour for board + non-fancy pieces
  boardCtx.clearRect(0, 0, BOARD_W, BOARD_H);
  boardCtx.drawImage(images["images/chessBoard.png"], 0, 0);

  // Pieces (skip the one being dragged from board so it doesn't appear twice)
  const dragFrom = (state.pointer && state.pointer.dragging && state.pointer.source === "board")
    ? state.pointer.payload.from : null;
  const doShadows   = fancyGraphics && fancyShadows;
  const doSway      = fancyGraphics && fancySway;
  const doHoverZoom = fancyGraphics && fancyHoverZoom;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (!p) continue;
      if (dragFrom && dragFrom.row === r && dragFrom.col === c) continue;
      const { x, y } = cellToCanvas(r, c);
      const img = images[pieceFile(p)];
      if (!img) continue;

      // ── Kanonkugel: mittig, unten (Kugel auf normaler Figurhöhe, Rauch nach unten)
      if (p.type === "20") {
        // Während Animation: am Zielfeld nicht zeichnen (wird animiert dargestellt)
        if (state.cannonAnim && state.cannonAnim.toRow === r && state.cannonAnim.toCol === c) continue;
        boardCtx.save();
        boardCtx.imageSmoothingEnabled = false;
        boardCtx.drawImage(img, x + Math.floor((CELL - 12) / 2) + 0.5, y + PIECE_VISUAL_OFFSET_Y + 10, 12, 33);
        boardCtx.restore();
        continue;
      }

      const imgX = x;
      const imgY = y + PIECE_VISUAL_OFFSET_Y;
      const _zoomProg  = doHoverZoom ? (_boardZoomMap.get(`${r},${c}`) || 0) : 0;
      const isHovered  = _zoomProg > 0;
      const hasFancyTransform = doSway || isHovered;

      boardCtx.save();

      if (fancyGraphics) {
        // ── Fancy path ────────────────────────────────────────────────────────
        // 1. Pre-render at native display resolution onto the sprite canvas
        //    with imageSmoothingEnabled = false (nearest-neighbour) so the
        //    source pixels stay perfectly crisp.
        const spriteSize = Math.ceil(CELL * state.scale * _dpr());
        const sCtx = _getSpriteCanvas(spriteSize);
        sCtx.clearRect(0, 0, spriteSize, spriteSize);
        sCtx.imageSmoothingEnabled = false;
        sCtx.drawImage(img, 0, 0, spriteSize, spriteSize);

        // Bake wappen directly onto sprite canvas (inherits shadow/sway/zoom)
        _drawWappenOnSprite(sCtx, spriteSize, p.type, p.color, p.skin);

        // 2. Composite the sprite canvas onto the board canvas WITH smoothing so
        //    any transforms (sway, zoom) benefit from bilinear filtering.
        boardCtx.imageSmoothingEnabled = true;
        boardCtx.imageSmoothingQuality = "high";

        // Drop-shadow (applied during the composite draw)
        if (doShadows) {
          boardCtx.shadowColor   = pixelShadows ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.96)";
          boardCtx.shadowBlur    = pixelShadows ? 0 : 8.4;
          boardCtx.shadowOffsetX = pixelShadows ? 0 : 2.4;
          boardCtx.shadowOffsetY = pixelShadows ? 8 : 4.8;
        }

        if (hasFancyTransform) {
          // Sway: rotate around the lower-quarter pivot of the figure
          if (doSway) {
            const pivotX = imgX + CELL / 2;
            const pivotY = imgY + CELL * 0.75;
            const angle  = getSwayAngle(r, c, swayTime);
            boardCtx.translate(pivotX, pivotY);
            boardCtx.rotate(angle);
            boardCtx.translate(-pivotX, -pivotY);
          }
          // Hover zoom: ease-out scale around the figure's center
          if (isHovered) {
            const eased = 1 - (1 - _zoomProg) * (1 - _zoomProg);
            const zoomS  = 1.0 + (HOVER_ZOOM_TARGET - 1.0) * eased;
            const cx = imgX + CELL / 2;
            const cy = imgY + CELL / 2;
            boardCtx.translate(cx, cy);
            boardCtx.scale(zoomS, zoomS);
            boardCtx.translate(-cx, -cy);
          }
        }

        // Draw the pre-rendered sprite at logical size — the board canvas CSS
        // scale handles the final display upscale.
        boardCtx.drawImage(_spriteCanvas, imgX, imgY, CELL, CELL);

        // Restore smoothing for the rest of drawBoard (markers etc.)
        boardCtx.imageSmoothingEnabled = false;

      } else {
        // ── Non-fancy path: nearest-neighbour direct draw ─────────────────────
        boardCtx.drawImage(img, imgX, imgY);
        // Wappen on non-fancy path (no sprite canvas — draw directly in logical px)
        drawWappenOnPiece(boardCtx, imgX, imgY, p.type, p.color, p.skin);
      }

      boardCtx.restore();
    }
  }

  // ── Geschlagene Figur während Kanonkugel-Animation ──────────────────────────
  // Bleibt sichtbar bis die Kugel ankommt (dann erst ins Grab)
  if (state.cannonAnim && state.cannonAnim.capturedPiece) {
    const cp = state.cannonAnim.capturedPiece;
    const { x: cpX, y: cpY } = cellToCanvas(state.cannonAnim.toRow, state.cannonAnim.toCol);
    const cpImg = images[pieceFile(cp)];
    if (cpImg) {
      boardCtx.save();
      boardCtx.imageSmoothingEnabled = false;
      if (cp.type === "20") {
        boardCtx.drawImage(cpImg, cpX + Math.floor((CELL - 12) / 2) + 0.5, cpY + PIECE_VISUAL_OFFSET_Y + 10, 12, 33);
      } else {
        boardCtx.drawImage(cpImg, cpX, cpY + PIECE_VISUAL_OFFSET_Y);
      }
      boardCtx.restore();
    }
  }

  // ── Animated Kanonkugel ─────────────────────────────────────────────────────
  if (state.cannonAnim) {
    const anim = state.cannonAnim;
    const elapsed = performance.now() - anim.startTime;
    const prog = Math.min(elapsed / CANNON_ANIM_MS, 1);
    const px = anim.fromX + (anim.toX - anim.fromX) * prog;
    const py = anim.fromY + (anim.toY - anim.fromY) * prog;
    const frame = Math.min(Math.floor(prog * 4), 3);
    const cImg = images[`images/figures/200${frame}.png`];
    if (cImg) {
      boardCtx.save();
      boardCtx.imageSmoothingEnabled = false;
      boardCtx.drawImage(cImg, px + Math.floor((CELL - 12) / 2), py + PIECE_VISUAL_OFFSET_Y, 12, 33);
      boardCtx.restore();
    }
  }

  // ── Glow — every piece emits a subtle static corona ─────────────────────
  // Drawn after all pieces so "lighter" compositing illuminates board + pieces alike.
  if (fancyGraphics && fancyGlow) {
    const selSq = state.selectedSquare && state.phase === PH_PLAY ? state.selectedSquare : null;
    const ambientDim = 1.0;

    const captureHighlights = new Set(
      currentHighlights().filter(h => h.capture).map(h => `${h.row},${h.col}`)
    );

    for (let gr = 0; gr < 8; gr++) {
      for (let gc = 0; gc < 8; gc++) {
        const p = state.board[gr][gc];
        if (!p) continue;
        if (dragFrom && dragFrom.row === gr && dragFrom.col === gc) continue;
        if (captureHighlights.has(`${gr},${gc}`)) continue;
        const { x, y } = cellToCanvas(gr, gc);
        _drawPieceGlow(boardCtx, x + CELL / 2, y + CELL * 0.62, p.color, p.type === "00", ambientDim);
      }
    }

    // Selected piece: additional stronger pulsing glow on top of the ambient one
    if (selSq) {
      const p = state.board[selSq.row][selSq.col];
      if (p) {
        const { x, y } = cellToCanvas(selSq.row, selSq.col);
        _drawSelectedPieceGlow(boardCtx, x + CELL / 2, y + CELL * 0.62, p.color, p.type === "00");
      }
    }
  }


  // Hover preview — projected piece on hovered valid cell (only on EMPTY squares)
  if (state.hoverCell) {
    const cellPiece = state.board[state.hoverCell.row][state.hoverCell.col];
    const isEmptyCell = !cellPiece;
    const isDragSource = dragFrom && dragFrom.row === state.hoverCell.row
                                   && dragFrom.col === state.hoverCell.col;
    if (isEmptyCell || isDragSource) {
      const previewPiece = getHoverPiece();
      if (previewPiece) {
        const { x, y } = cellToCanvas(state.hoverCell.row, state.hoverCell.col);
        const img = images[pieceFile(previewPiece)];
        if (img) {
          boardCtx.save();
          try { boardCtx.filter = "saturate(50%)"; } catch (e) {}
          boardCtx.globalAlpha = 0.5;
          if (previewPiece.type === "20") {
            boardCtx.imageSmoothingEnabled = false;
            boardCtx.drawImage(img, x + Math.floor((CELL - 12) / 2) + 0.5, y + PIECE_VISUAL_OFFSET_Y + 10, 12, 33);
          } else {
            boardCtx.drawImage(img, x, y + PIECE_VISUAL_OFFSET_Y);
            drawWappenOnPiece(boardCtx, x, y + PIECE_VISUAL_OFFSET_Y, previewPiece.type, previewPiece.color, previewPiece.skin);
          }
          boardCtx.restore();
        }
      }
    }
  }

  // Hover move preview — faint semi-transparent dots showing pseudo-moves of hovered piece
  if (_hoverPreviewMoves && _hoverPreviewMoves.length > 0) {
    boardCtx.save();
    boardCtx.globalAlpha = 0.30;
    boardCtx.shadowColor = "transparent";
    boardCtx.shadowBlur  = 0;
    boardCtx.imageSmoothingEnabled = true;
    boardCtx.imageSmoothingQuality = "high";
    for (const m of _hoverPreviewMoves) {
      const { x, y } = cellToCanvas(m.row, m.col);
      const cv = m.capture ? _markerHitCanvas : _markerCanvas;
      if (cv) boardCtx.drawImage(cv, x, y, CELL, CELL);
    }
    boardCtx.imageSmoothingEnabled = false;
    boardCtx.restore();
  }

  // Markers ON TOP of pieces & hover preview
  const highlights = currentHighlights();
  boardCtx.imageSmoothingEnabled = true;
  boardCtx.imageSmoothingQuality = "high";
  for (const h of highlights) {
    const { x, y } = cellToCanvas(h.row, h.col);
    const cv = h.capture ? _markerHitCanvas : _markerCanvas;
    if (!cv) continue;
    const cx = x + CELL / 2;
    const cy = y + CELL / 2;
    boardCtx.save();
    if (fancyGraphics && fancyShadows) {
      boardCtx.shadowColor   = "rgba(0,0,0,1.0)";
      boardCtx.shadowBlur    = 4.8;
      boardCtx.shadowOffsetX = 1.2;
      boardCtx.shadowOffsetY = 2.4;
    }
    boardCtx.drawImage(cv, x, y, CELL, CELL);
    boardCtx.restore();
    // Glow on top of the sprite
    if (fancyGraphics && fancyGlow && fancyGlowMarkers) {
      const _pc = state.board[h.row]?.[h.col];
      _drawMarkerGlow(boardCtx, cx, cy, h.capture, _pc ? _pc.color : null);
    }
  }
  boardCtx.imageSmoothingEnabled = false;

}

// ── Full-screen drag-piece canvas ─────────────────────────────────────────────
// The dragged piece is rendered here (not on the board canvas) so it isn't
// clipped to the board edges.  The canvas is position:fixed, covers 100vw×100vh,
// and is transparent except for the piece + glow.

function _updateDragCanvasSize() {
  if (!_dragCanvas) return;
  const dpr = _dpr();
  _dragCanvas.width  = Math.round(window.innerWidth  * dpr);
  _dragCanvas.height = Math.round(window.innerHeight * dpr);
  _dragCanvas.style.width  = window.innerWidth  + "px";
  _dragCanvas.style.height = window.innerHeight + "px";
}

function _clearDragCanvas() {
  if (!_dragCtx) return;
  _dragCtx.setTransform(1, 0, 0, 1, 0, 0);
  _dragCtx.clearRect(0, 0, _dragCanvas.width, _dragCanvas.height);
}

function _drawDragCanvas() {
  if (!_dragCanvas || !_dragCtx) return;
  if (!state.pointer || !state.pointer.dragging) { _clearDragCanvas(); return; }

  const dpr = _dpr();
  const s   = state.scale;

  // Apply same logical scale as the board canvas so CELL units match visually.
  _dragCtx.setTransform(1, 0, 0, 1, 0, 0);
  _dragCtx.clearRect(0, 0, _dragCanvas.width, _dragCanvas.height);
  _dragCtx.scale(s * dpr, s * dpr);

  // Client CSS-pixel coords → logical board-scale coords
  const lx = _dragClientX / s;
  const ly = _dragClientY / s;

  // Resolve which piece is being dragged
  let dragPiece = null;
  if (state.pointer.source === "board") {
    dragPiece = state.pointer.payload.piece;
  } else if (state.pointer.source === "hotbar") {
    const player = state.online.active ? state.online.myColor : state.current;
    if (state.pointer.payload.kind === "king") {
      dragPiece = { color: player, type: "00", skin: 0 };
    } else if (state.pointer.payload.kind === "piece") {
      dragPiece = { color: player, type: state.pointer.payload.type, skin: 0 };
    }
  }

  if (!dragPiece) return;

  const img  = images[pieceFile(dragPiece)];
  const imgX = lx - CELL / 2;
  const imgY = ly - CELL * 0.25 + PIECE_VISUAL_OFFSET_Y;  // grabbed at 25% height

  if (img) {
    _dragCtx.save();

    // Drag tilt — rotate around the cursor point
    if (dragTilt) {
      const angleDeg = Math.max(-DRAG_TILT_MAX,
                       Math.min( DRAG_TILT_MAX, _dragTiltVX * DRAG_TILT_SCALE));
      const angleRad = angleDeg * Math.PI / 180;
      const pivotX   = lx;
      const pivotY   = imgY + CELL * 0.25;
      _dragCtx.translate(pivotX, pivotY);
      _dragCtx.rotate(angleRad);
      _dragCtx.translate(-pivotX, -pivotY);
    }

    // Drop shadow when fancy shadows are on
    if (fancyGraphics && fancyShadows) {
      _dragCtx.shadowColor   = pixelShadows ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,1.0)";
      _dragCtx.shadowBlur    = pixelShadows ? 0 : 12;
      _dragCtx.shadowOffsetX = pixelShadows ? 0 : 3.6;
      _dragCtx.shadowOffsetY = pixelShadows ? 10 : 6;
    }

    if (dragPiece.type === "20") {
      // Kanonkugel: natürliche Größe 12×33, zentriert auf Cursor (gleicher Offset wie auf Board)
      _dragCtx.imageSmoothingEnabled = false;
      _dragCtx.shadowColor   = "rgba(0,0,0,1.0)";
      _dragCtx.shadowBlur    = 18;
      _dragCtx.shadowOffsetX = 2;
      _dragCtx.shadowOffsetY = 8;
      const cX = lx - 6 + 0.5;
      const cY = ly - 6;  // Kugel (top 12px) zentriert auf Cursor
      _dragCtx.drawImage(img, cX, cY, 12, 33);
    } else {
      _dragCtx.imageSmoothingEnabled = true;
      _dragCtx.imageSmoothingQuality = "high";
      // Pre-render via sprite canvas for sharp nearest-neighbour source
      if (fancyGraphics) {
        const spriteSize = Math.ceil(CELL * s * dpr);
        const sCtx = _getSpriteCanvas(spriteSize);
        sCtx.clearRect(0, 0, spriteSize, spriteSize);
        sCtx.imageSmoothingEnabled = false;
        sCtx.drawImage(img, 0, 0, spriteSize, spriteSize);
        _drawWappenOnSprite(sCtx, spriteSize, dragPiece.type, dragPiece.color, dragPiece.skin);
        _dragCtx.drawImage(_spriteCanvas, imgX, imgY, CELL, CELL);
      } else {
        _dragCtx.imageSmoothingEnabled = false;
        _dragCtx.drawImage(img, imgX, imgY);
        drawWappenOnPiece(_dragCtx, imgX, imgY, dragPiece.type, dragPiece.color, dragPiece.skin);
      }
    }

    _dragCtx.restore();
  }

  // Glow on top — tight bright core, very faint outer bloom
  if (fancyGraphics && fancyGlow) {
    _drawDragPieceGlow(_dragCtx, lx, ly + CELL * 0.25 + PIECE_VISUAL_OFFSET_Y * 0.5,
                       dragPiece.color, dragPiece.type === "00");
  }
}

function getHoverPiece() {
  const player = state.current;
  // While dragging, preview the dragged piece
  if (state.pointer && state.pointer.dragging) {
    if (state.pointer.source === "hotbar") {
      if (state.pointer.payload.kind === "king") {
        return { color: player, type: "00", skin: 0 };
      }
      if (state.pointer.payload.kind === "piece") {
        return { color: player, type: state.pointer.payload.type, skin: 0 };
      }
    }
    if (state.pointer.source === "board") {
      return state.pointer.payload.piece;
    }
  }
  // Otherwise infer from current selection / phase
  if (state.phase === PH_KING_PLACE) {
    return { color: player, type: "00", skin: 0 };
  }
  if (state.phase === PH_SETUP) {
    const idx = state.selectedHotbarIdx[player];
    if (idx === null) return null;
    const type = state.hotbars[player][idx];
    return { color: player, type, skin: 0 };
  }
  if (state.phase === PH_PLAY) {
    if (!state.selectedSquare) return null;
    return state.board[state.selectedSquare.row][state.selectedSquare.col];
  }
  return null;
}

function isValidHoverCell(cell) {
  const highlights = currentHighlights();
  return highlights.some(h => h.row === cell.row && h.col === cell.col);
}

function updateHoverFromClient(clientX, clientY) {
  if (state.animating || state.phase === PH_END) {
    if (state.hoverCell !== null) { state.hoverCell = null; drawBoard(); }
    _clearBoardHoverZoom();
    return;
  }
  const pos = getCanvasNativePos(boardCanvas, clientX, clientY);
  if (!pos.inside) {
    if (state.hoverCell !== null) { state.hoverCell = null; drawBoard(); }
    _clearBoardHoverZoom();
    return;
  }
  const cell = canvasToCell(pos.x, pos.y);

  // Hover zoom — own pieces only
  _updateBoardHoverZoom(cell);

  // Hover move preview — show pseudo-moves of whatever piece is under the cursor
  let previewChanged = false;
  const piece = cell ? state.board[cell.row][cell.col] : null;
  const prevCell = _hoverPreviewCell;
  if (piece) {
    const sameCell = prevCell && prevCell.row === cell.row && prevCell.col === cell.col;
    if (!sameCell) {
      _hoverPreviewCell  = cell;
      _hoverPreviewMoves = pseudoMoves(state.board, cell.row, cell.col, state.enPassant);
      previewChanged = true;
    }
  } else {
    if (_hoverPreviewCell !== null) {
      _hoverPreviewCell  = null;
      _hoverPreviewMoves = null;
      previewChanged = true;
    }
  }

  // Valid hover (only placement / move targets)
  const valid = cell && isValidHoverCell(cell) ? cell : null;
  const validChanged = !( valid && state.hoverCell
      && valid.row === state.hoverCell.row && valid.col === state.hoverCell.col )
    && !(!valid && !state.hoverCell);

  state.hoverCell = valid;

  // ── Piece tooltip: show on opponent special pieces during setup ──
  if (state.phase === PH_SETUP || state.phase === PH_KING_PLACE) {
    const p = cell ? state.board[cell.row][cell.col] : null;
    const opponentColor = state.online.active ? (1 - state.online.myColor) : (1 - state.current);
    const desc = (p && p.color === opponentColor) ? PIECE_TOOLTIP_DESC[p.type] : null;
    if (desc) _showPieceTooltip(desc, _lastMouseX, _lastMouseY);
    else       _hidePieceTooltip();
  } else {
    _hidePieceTooltip();
  }

  // Sway loop redraws continuously; only manual redraw when not sway-looping
  if ((validChanged || previewChanged) && (!fancyGraphics || !fancySway)) drawBoard();
}

function _ownPlayerColor() {
  return state.online.active ? state.online.myColor : state.current;
}

function _updateBoardHoverZoom(cell) {
  if (!fancyGraphics || !fancyHoverZoom) return;
  const p = cell ? state.board[cell.row][cell.col] : null;
  const isOwn = p && p.color === _ownPlayerColor();
  const newKey = isOwn ? `${cell.row},${cell.col}` : null;
  if (newKey === _boardZoomTarget) return;
  _boardZoomTarget = newKey;
  // Ensure a new target starts from 0 so it always animates in from scratch.
  if (newKey && !_boardZoomMap.has(newKey)) {
    _boardZoomMap.set(newKey, 0);
  }
  _startBoardZoomLoop();
}

function _clearBoardHoverZoom() {
  if (!fancyGraphics || !fancyHoverZoom) return;
  if (_boardZoomTarget !== null) {
    _boardZoomTarget = null;
    _startBoardZoomLoop();
  }
}

function currentHighlights() {
  if (state.animating) return [];
  // Online: never show highlights for the opponent's turn (setup/king-place phases)
  if (state.online.active && state.current !== state.online.myColor
      && state.phase !== PH_PLAY) return [];
  if (state.phase === PH_KING_PLACE) {
    const player = state.current;
    if (state.kingsPlaced[player]) return [];
    const row = grundReihe(player);
    const list = [];
    for (let c = 0; c < 8; c++) {
      if (canPlaceKingAt(player, row, c)) list.push({ row, col: c, capture: false });
    }
    return list;
  }
  if (state.phase === PH_SETUP) {
    const player = state.current;
    const idx = state.selectedHotbarIdx[player];
    if (idx === null) return [];
    const type = state.hotbars[player][idx];
    if (state.budgets[player] < PIECE_INFO[type].cost) return [];
    const list = [];
    for (const r of ownHalfRows(player)) {
      for (let c = 0; c < 8; c++) {
        if (canPlacePieceAt(player, r, c)) list.push({ row: r, col: c, capture: false });
      }
    }
    return list;
  }
  if (state.phase === PH_PLAY) return state.legalMoves;
  return [];
}

function drawHotbar() {
  const visible = (state.phase === PH_SETUP);
  document.getElementById("hotbar-stage").classList.toggle("visible", visible);
  if (!visible) return;

  const s   = state.scale;
  const dpr = _dpr();
  const R   = s * dpr;          // physical pixels per logical unit (same as board)
  hotbarCtx.setTransform(R, 0, 0, R, 0, 0);
  hotbarCtx.clearRect(0, 0, BOARD_W, HOTBAR_CANVAS_H);

  // ── Background ───────────────────────────────────────────────
  hotbarCtx.imageSmoothingEnabled = false;
  hotbarCtx.drawImage(images["images/hotbar.png"], hotbarOriginInCanvas().x, hotbarOriginInCanvas().y);

  const o = hotbarOriginInCanvas();
  const player = state.online.active ? state.online.myColor : state.current;
  const hotbar = state.hotbars[player];
  const draggingHotbarIdx = (state.pointer && state.pointer.dragging
                              && state.pointer.source === "hotbar")
                            ? state.pointer.payload.slot : -1;

  const doSway    = fancyGraphics && fancySway;
  const doZoom    = fancyGraphics && fancyHoverZoom;
  const doShadows = fancyGraphics && fancyShadows;
  // Sprite canvas: same pipeline as board (nearest-neighbour source → smooth transform output)
  const spriteSize = Math.ceil(CELL * s * dpr);

  for (let i = 0; i < 4; i++) {
    const type   = hotbar[i];
    const slotX  = o.x + hotbarSlotX(i);
    const img    = images[`images/figures/${player}${type}0.png`];
    const py     = o.y + (HOTBAR_H - CELL) / 2 + PIECE_VISUAL_OFFSET_Y;
    const cost   = PIECE_INFO[type].cost;
    const canAfford  = state.budgets[player] >= cost;
    const isSelected = state.selectedHotbarIdx[player] === i;
    const isDragging = (i === draggingHotbarIdx);

    let alpha = canAfford ? 1.0 : 0.45;
    if (isDragging) alpha = 0.35;

    const cx = slotX + CELL / 2;
    const cy = py    + CELL / 2;

    hotbarCtx.save();
    hotbarCtx.globalAlpha = alpha;

    // ── Sway ────────────────────────────────────────────────────
    if (doSway && !isDragging) {
      const angle    = getSwayAngle(0, i, swayTime);
      const pivotY   = py + CELL * 0.75;
      hotbarCtx.translate(cx, pivotY);
      hotbarCtx.rotate(angle);
      hotbarCtx.translate(-cx, -pivotY);
    }

    // ── Hover zoom ───────────────────────────────────────────────
    if (doZoom && hoverZoomHotbarSlot === i && _hotbarZoomProgress > 0) {
      const eased = 1 - (1 - _hotbarZoomProgress) * (1 - _hotbarZoomProgress);
      const zoomS  = 1.0 + (HOVER_ZOOM_TARGET - 1.0) * eased;
      hotbarCtx.translate(cx, cy);
      hotbarCtx.scale(zoomS, zoomS);
      hotbarCtx.translate(-cx, -cy);
    }

    // ── Kanonkugel: eigene Darstellung (12×33, zentriert im Slot) ──────────────
    if (type === "20") {
      const cImg20 = images["images/figures/2000.png"];
      if (cImg20) {
        hotbarCtx.imageSmoothingEnabled = false;
        if (doShadows) {
          hotbarCtx.shadowColor   = "rgba(0,0,0,0.7)";
          hotbarCtx.shadowBlur    = 4;
          hotbarCtx.shadowOffsetX = 0;
          hotbarCtx.shadowOffsetY = 3;
        }
        if (isSelected) {
          hotbarCtx.translate(cx, cy);
          hotbarCtx.scale(1.25, 1.25);
          hotbarCtx.translate(-cx, -cy);
        }
        hotbarCtx.drawImage(cImg20, slotX + Math.floor((CELL - 12) / 2) + 0.5, o.y + 8, 12, 33);
      }
    } else if (img) {
      // ── Sprite canvas (nearest-neighbour source, smooth transform output) ──
      const sCtx = _getSpriteCanvas(spriteSize);
      sCtx.clearRect(0, 0, spriteSize, spriteSize);
      sCtx.imageSmoothingEnabled = false;
      sCtx.drawImage(img, 0, 0, spriteSize, spriteSize);
      _drawWappenOnSprite(sCtx, spriteSize, type, player);

      hotbarCtx.imageSmoothingEnabled = true;
      hotbarCtx.imageSmoothingQuality = "high";

      // ── Drop shadow ──────────────────────────────────────────────
      if (doShadows) {
        if (isSelected) {
          hotbarCtx.shadowColor   = pixelShadows ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.96)";
          hotbarCtx.shadowOffsetX = 0;
          hotbarCtx.shadowOffsetY = pixelShadows ? 4 : 2.4;
          hotbarCtx.shadowBlur    = pixelShadows ? 0 : 1.2;
        } else {
          hotbarCtx.shadowColor   = pixelShadows ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.48)";
          hotbarCtx.shadowOffsetX = 0;
          hotbarCtx.shadowOffsetY = pixelShadows ? 3 : 1.2;
          hotbarCtx.shadowBlur    = 0;
        }
      }

      // ── Selected: draw at 1.25× (on top of sway/zoom transforms) ──
      if (isSelected) {
        const s = 1.25;
        hotbarCtx.translate(cx, cy);
        hotbarCtx.scale(s, s);
        hotbarCtx.translate(-cx, -cy);
      }
      hotbarCtx.drawImage(_spriteCanvas, slotX, py, CELL, CELL);
    }

    hotbarCtx.restore();

    // ── Cost digit ──────────────────────────────────────────────
    const costColor  = canAfford ? "#ffe45c" : "#888";
    const slotRight  = slotX + HOTBAR_SLOT_W;
    const slotBottom = o.y + (HOTBAR_H - HOTBAR_BORDER);
    drawPixelNumber(hotbarCtx, cost, slotRight - 1, slotBottom - 1, costColor, "rgba(0,0,0,0.7)");
  }

  // ── Composite pre-rendered glow buffer onto piece canvas (additive, same as board) ──
  if (fancyGraphics && fancyGlow) {
    hotbarCtx.save();
    hotbarCtx.setTransform(1, 0, 0, 1, 0, 0);   // identity: pixel-exact copy
    hotbarCtx.globalCompositeOperation = "lighter";
    hotbarCtx.drawImage(hotbarGlowCanvas, 0, 0);
    hotbarCtx.restore();
  }
}

function drawHotbarGlow() {
  if (state.phase !== PH_SETUP || !fancyGraphics || !fancyGlow) {
    hotbarGlowCtx.clearRect(0, 0, hotbarGlowCanvas.width, hotbarGlowCanvas.height);
    return;
  }

  const R = state.scale * _dpr();
  hotbarGlowCtx.setTransform(R, 0, 0, R, 0, 0);
  hotbarGlowCtx.clearRect(0, 0, BOARD_W, HOTBAR_CANVAS_H);
  hotbarGlowCtx.globalCompositeOperation = "lighter";

  const o      = hotbarOriginInCanvas();
  const player = state.online.active ? state.online.myColor : state.current;
  const hotbar = state.hotbars[player];

  for (let i = 0; i < 4; i++) {
    const type       = hotbar[i];
    const slotX      = o.x + hotbarSlotX(i);
    const py         = o.y + (HOTBAR_H - CELL) / 2 + PIECE_VISUAL_OFFSET_Y;
    const isSelected = state.selectedHotbarIdx[player] === i;
    const canAfford  = state.budgets[player] >= PIECE_INFO[type].cost;
    const cx         = slotX + CELL / 2;
    const cy         = py    + CELL * 0.55;

    hotbarGlowCtx.save();
    if (isSelected) {
      hotbarGlowCtx.globalAlpha = 0.5;
      _drawHotbarGlow(hotbarGlowCtx, cx, cy, player);
    } else if (canAfford) {
      hotbarGlowCtx.globalAlpha = 0.28;
      _drawHotbarGlow(hotbarGlowCtx, cx, cy, player);
    }
    hotbarGlowCtx.restore();
  }

  // Clip glow to the hotbar sprite shape — removes any bleed beyond its visible pixels
  hotbarGlowCtx.globalCompositeOperation = "destination-in";
  hotbarGlowCtx.drawImage(images["images/hotbar.png"], o.x, o.y);
  hotbarGlowCtx.globalCompositeOperation = "source-over";
}

function drawHotbarFigure(ctx, img, x, y, isSelected, alpha) {
  if (!img) return;
  // Shadow values are in INTERNAL canvas pixels (not affected by ctx.scale).
  // We multiply by HOTBAR_INTERNAL_SCALE to keep visuals consistent in logical units.
  const R = HOTBAR_INTERNAL_SCALE;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (isSelected) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.96)";
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2.4 * R;
    ctx.shadowBlur = 1.2 * R;
    const cx = x + CELL / 2;
    const cy = y + CELL / 2;
    const s = 1.25;     // with R=4 → 5/4 ratio → clean 5x integer source-to-internal scaling
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, -CELL / 2, -CELL / 2);
  } else {
    ctx.shadowColor = "rgba(0, 0, 0, 0.48)";
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1.2 * R;
    ctx.shadowBlur = 0;
    ctx.drawImage(img, x, y);
  }
  ctx.restore();
}

function drawHud() {
  const phaseLabel = document.getElementById("phase-label");
  const playerLabel = document.getElementById("player-label");
  const coinValue  = document.getElementById("coin-value");
  const starValue  = document.getElementById("star-value");
  const finishBtn  = document.getElementById("finish-btn");
  const resignBtn  = document.getElementById("resign-btn");
  const messageEl  = document.getElementById("message");
  const coinLabel  = document.getElementById("coin-label");
  const starLabel  = document.getElementById("star-label");

  phaseLabel.textContent = ({
    [PH_KING_PLACE]: "Place King",
    [PH_SETUP]:      "Setup",
    [PH_PLAY]:       "Playing",
    [PH_END]:        "Game Over",
  })[state.phase];

  playerLabel.textContent = state.current === P1 ? "P1 Orange" : "P2 Blue";
  playerLabel.className = state.current === P1 ? "p1" : "p2";

  // Online: always show MY budget. Local: show current player's budget.
  const budgetPlayer = state.online.active ? state.online.myColor : state.current;
  coinValue.textContent = state.budgets[budgetPlayer];
  if (starValue) starValue.textContent = state.stars[budgetPlayer];
  // Coins and stars are only relevant during setup
  if (coinLabel) coinLabel.style.visibility = (state.phase === PH_SETUP) ? "" : "hidden";
  if (starLabel) starLabel.style.visibility = (state.phase === PH_SETUP) ? "" : "hidden";

  if (state.phase === PH_SETUP) {
    finishBtn.classList.remove("hidden");
    finishBtn.textContent = state.setupDone[state.current] ? "Waiting…" : "Done";
    finishBtn.disabled = state.setupDone[state.current];
  } else {
    finishBtn.classList.add("hidden");
  }

  // Resign sichtbar in allen Phasen außer PH_END
  if (state.phase !== PH_END) {
    resignBtn.classList.remove("hidden");
  } else {
    resignBtn.classList.add("hidden");
  }

  // ONLINE: override message when waiting for opponent's turn
  if (state.online.active && state.current !== state.online.myColor && state.phase !== PH_END) {
    messageEl.textContent = "Waiting for opponent…";
    return;
  }

  // Auto-message hints
  if (state.phase === PH_KING_PLACE && !state.message) {
    messageEl.textContent = "Click a square in your back rank to place the King.";
  } else {
    messageEl.textContent = state.message;
  }
}

// ============================================================
// Scaling
// ============================================================

// Returns the current device pixel ratio (≥1; 2 on Retina/HiDPI displays).
function _dpr() { return window.devicePixelRatio || 1; }

function applyBoardCanvasMode() {
  const s   = state.scale;
  const dpr = _dpr();
  // Board canvas: physical size = logical × scale × dpr  →  pixel-perfect on HiDPI.
  boardCanvas.width  = Math.round(BOARD_W * s * dpr);
  boardCanvas.height = Math.round(BOARD_H * s * dpr);
  boardCanvas.style.width  = (BOARD_W * s) + "px";
  boardCanvas.style.height = (BOARD_H * s) + "px";
  // Hotbar canvases: same DPR-aware sizing.
  const hw = Math.round(BOARD_W       * s * dpr);
  const hh = Math.round(HOTBAR_CANVAS_H * s * dpr);
  hotbarCanvas.width      = hw;  hotbarCanvas.height      = hh;
  hotbarGlowCanvas.width  = hw;  hotbarGlowCanvas.height  = hh;
  _buildMarkerCanvases();
}

function updateScale() {
  const wrapper   = document.getElementById("stage-wrapper");
  const statusBar = document.getElementById("status-bar");
  const statusBarH = statusBar ? statusBar.offsetHeight + 6 : 64;
  const availW = wrapper.clientWidth  - 16;
  const availH = wrapper.clientHeight - 16 - statusBarH;
  const totalH = BOARD_H + 8 + HOTBAR_CANVAS_H;
  const scaleW = availW / BOARD_W;
  const scaleH = availH / totalH;
  let s = Math.min(scaleW, scaleH);
  if (!fancyGraphics) s = Math.floor(s); // integer steps keep pixel art grid-aligned
  if (s < 1) s = 1;
  if (s > 8) s = 8;
  state.scale = s;
  document.documentElement.style.setProperty("--scale", s);
  applyBoardCanvasMode();
}

// ============================================================
// Pointer / Drag system
// ============================================================
function getCanvasNativePos(canvas, clientX, clientY) {
  // Returns LOGICAL coords (independent of internal render resolution).
  const rect = canvas.getBoundingClientRect();
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  const logicalW = BOARD_W;
  const logicalH = (canvas === hotbarCanvas) ? HOTBAR_CANVAS_H : BOARD_H;
  return {
    x: (cssX / rect.width) * logicalW,
    y: (cssY / rect.height) * logicalH,
    inside: cssX >= 0 && cssY >= 0 && cssX <= rect.width && cssY <= rect.height,
  };
}

const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=";

function setDragOverlay(visible, imgSrc) {
  // DOM overlay is not used — piece is drawn on the full-screen drag canvas.
  if (!visible) {
    _dragTiltVX = 0; _dragTiltLastX = null; _dragTiltLastT = null;
    _clearDragCanvas();
    drawBoard();
  }
}

function moveDragOverlay(clientX, clientY) {
  _dragClientX = clientX;
  _dragClientY = clientY;

  if (dragTilt) {
    const now = performance.now();
    if (_dragTiltLastX !== null && _dragTiltLastT !== null) {
      const dt  = Math.max((now - _dragTiltLastT) / 1000, 0.004);
      const raw = (clientX - _dragTiltLastX) / dt;
      _dragTiltVX = _dragTiltVX * 0.75 + raw * 0.25;
    }
    _dragTiltLastX = clientX;
    _dragTiltLastT = now;
    _startDragTiltDecay();
  }

  if (!state.animating) { drawBoard(); _drawDragCanvas(); }
}

function _startDragTiltDecay() {
  if (_dragTiltDecayRAF) return;
  _dragTiltDecayRAF = requestAnimationFrame(function decay() {
    if (!dragTilt || !state.pointer || !state.pointer.dragging) {
      _dragTiltDecayRAF = null;
      return;
    }
    _dragTiltVX *= 0.88;
    if (!state.animating) { drawBoard(); _drawDragCanvas(); }
    _dragTiltDecayRAF = requestAnimationFrame(decay);
  });
}

function onPointerDown(evt) {
  // ONLINE GUARD — block input when it is not this client's turn
  if (state.online.active && state.current !== state.online.myColor) return;
  if (state.animating || state.phase === PH_END) return;
  const targetCanvas = evt.target;
  if (targetCanvas !== boardCanvas && targetCanvas !== hotbarCanvas) return;

  evt.preventDefault();
  const player = state.current;

  if (targetCanvas === hotbarCanvas) {
    const pos = getCanvasNativePos(hotbarCanvas, evt.clientX, evt.clientY);
    if (!pos.inside) return;
    if (state.phase === PH_KING_PLACE) {
      if (state.kingsPlaced[player]) return;
      const o = hotbarOriginInCanvas();
      const kx = o.x + (HOTBAR_W - 23) / 2;
      const ky = o.y + (HOTBAR_H - 23) / 2;
      // any click inside hotbar starts king drag
      if (pos.x < o.x || pos.x > o.x + HOTBAR_W) return;
      state.pointer = {
        source: "hotbar",
        payload: { kind: "king", imgSrc: `images/figures/${player}000.png` },
        startX: evt.clientX, startY: evt.clientY,
        dragging: false,
      };
      setupGlobalPointer();
      return;
    }
    if (state.phase === PH_SETUP) {
      if (state.setupDone[player]) return;
      const slot = hotbarPxToSlot(pos.x, pos.y);
      if (slot === null) return;
      const type = state.hotbars[player][slot];
      if (state.budgets[player] < PIECE_INFO[type].cost) return;
      Sounds.play("select");
      state.selectedHotbarIdx[player] = slot;
      state.pointer = {
        source: "hotbar",
        payload: { kind: "piece", slot, type, imgSrc: `images/figures/${player}${type}0.png` },
        startX: evt.clientX, startY: evt.clientY,
        dragging: false,
      };
      setupGlobalPointer();
      drawAll();
      return;
    }
    return;
  }

  // boardCanvas
  if (targetCanvas === boardCanvas) {
    const pos = getCanvasNativePos(boardCanvas, evt.clientX, evt.clientY);
    if (!pos.inside) return;
    const cell = canvasToCell(pos.x, pos.y);
    if (!cell) return;

    if (state.phase === PH_PLAY) {
      const piece = state.board[cell.row][cell.col];
      if (piece && piece.color === player) {
        state.selectedSquare = { row: cell.row, col: cell.col };
        state.legalMoves = legalMoves(state.board, cell.row, cell.col);
        state.pointer = {
          source: "board",
          payload: { from: cell, piece, imgSrc: pieceFile(piece) },
          startX: evt.clientX, startY: evt.clientY,
          dragging: false,
        };
        setupGlobalPointer();
        drawAll();
        return;
      }
      // Click on empty / enemy with selection → handled on pointerup as click
      if (state.selectedSquare) {
        state.pointer = {
          source: "board-click",
          payload: { cell },
          startX: evt.clientX, startY: evt.clientY,
          dragging: false,
        };
        setupGlobalPointer();
      }
      return;
    }
    if (state.phase === PH_KING_PLACE || state.phase === PH_SETUP) {
      // Allow click-to-place as a fallback
      state.pointer = {
        source: "board-click",
        payload: { cell },
        startX: evt.clientX, startY: evt.clientY,
        dragging: false,
      };
      setupGlobalPointer();
      return;
    }
  }
}

function setupGlobalPointer() {
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onPointerUp);
}

function teardownGlobalPointer() {
  document.removeEventListener("pointermove", onPointerMove);
  document.removeEventListener("pointerup", onPointerUp);
  document.removeEventListener("pointercancel", onPointerUp);
}

function onPointerMove(evt) {
  if (!state.pointer) return;
  const dx = evt.clientX - state.pointer.startX;
  const dy = evt.clientY - state.pointer.startY;
  if (!state.pointer.dragging) {
    if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      // Promote to drag, but only sources that have a draggable payload
      if (state.pointer.source === "hotbar" || state.pointer.source === "board") {
        state.pointer.dragging = true;
        setDragOverlay(true, state.pointer.payload.imgSrc);
        moveDragOverlay(evt.clientX, evt.clientY);
        drawAll(); // redraw to hide source piece while dragging
      }
    }
  } else {
    moveDragOverlay(evt.clientX, evt.clientY);
    updateHoverFromClient(evt.clientX, evt.clientY);
  }
}

function onBoardHoverMove(evt) {
  _lastMouseX = evt.clientX;
  _lastMouseY = evt.clientY;
  updateHoverFromClient(evt.clientX, evt.clientY);
}

function onHotbarHoverMove(evt) {
  if (!fancyGraphics || !fancyHoverZoom) return;
  if (state.animating || state.phase !== PH_SETUP) { _clearHotbarHoverZoom(); return; }
  const pos = getCanvasNativePos(hotbarCanvas, evt.clientX, evt.clientY);
  if (!pos.inside) { _clearHotbarHoverZoom(); return; }
  const slot = hotbarPxToSlot(pos.x, pos.y);
  if (hoverZoomHotbarSlot !== slot) {
    hoverZoomHotbarSlot = slot;
    _startHotbarZoomLoop();
  }
}

function _clearHotbarHoverZoom() {
  if (hoverZoomHotbarSlot !== null) {
    hoverZoomHotbarSlot = null;
    _startHotbarZoomLoop();
  }
}

function onBoardHoverLeave() {
  const needRedraw = state.hoverCell !== null || _hoverPreviewCell !== null;
  state.hoverCell = null;
  _hoverPreviewCell  = null;
  _hoverPreviewMoves = null;
  _clearBoardHoverZoom();
  _hidePieceTooltip();
  if (needRedraw && (!fancyGraphics || !fancySway)) drawBoard();
}

function onPointerUp(evt) {
  const ptr = state.pointer;
  if (!ptr) { teardownGlobalPointer(); return; }
  teardownGlobalPointer();
  state.pointer = null;

  if (ptr.dragging) {
    setDragOverlay(false, "");
    handleDrop(ptr, evt.clientX, evt.clientY);
    drawAll();
    return;
  }
  // Treat as click — based on where pointer was released
  const onBoard = isPointerOnCanvas(boardCanvas, evt.clientX, evt.clientY);
  if (onBoard) {
    const pos = getCanvasNativePos(boardCanvas, evt.clientX, evt.clientY);
    const cell = canvasToCell(pos.x, pos.y);
    if (cell) handleBoardClick(cell.row, cell.col);
  }
  drawAll();
}

function isPointerOnCanvas(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
}

function handleDrop(ptr, clientX, clientY) {
  const onBoard = isPointerOnCanvas(boardCanvas, clientX, clientY);
  if (!onBoard) {
    // Cancel — for board source, simply re-render (piece returns)
    return;
  }
  const pos = getCanvasNativePos(boardCanvas, clientX, clientY);
  const cell = canvasToCell(pos.x, pos.y);
  if (!cell) return;
  const player = state.current;

  if (ptr.source === "hotbar") {
    if (ptr.payload.kind === "king") {
      if (state.phase !== PH_KING_PLACE) return;
      if (!canPlaceKingAt(player, cell.row, cell.col)) return;
      state.board[cell.row][cell.col] = makePiece(player, "00", 0);
      state.kingsPlaced[player] = true;
      Sounds.play("place");
      if (state.online.active && window.Online) Online.emitKingPlace(cell.row, cell.col, 0);
      nextPlayerOrAdvance();
      return;
    }
    if (ptr.payload.kind === "piece") {
      if (state.phase !== PH_SETUP) return;
      if (state.setupDone[player]) return;
      const type = ptr.payload.type;
      if (state.budgets[player] < PIECE_INFO[type].cost) return;
      if (state.stars[player] <= 0) return;
      if (!canPlacePieceAt(player, cell.row, cell.col)) return;
      state.board[cell.row][cell.col] = makePiece(player, type);
      state.budgets[player] -= PIECE_INFO[type].cost;
      state.stars[player]   -= 1;
      Sounds.play("place");
      if (state.online.active && window.Online) Online.emitPiecePlace(cell.row, cell.col, type, state.board[cell.row][cell.col].skin);
      recomputeSetupDoneAfterPlacement(player);
      advanceSetupTurn();
      return;
    }
  }

  if (ptr.source === "board") {
    if (state.phase !== PH_PLAY) return;
    const from = ptr.payload.from;
    if (from.row === cell.row && from.col === cell.col) {
      // dropped on origin, treat as just selecting (already selected)
      return;
    }
    const move = state.legalMoves.find(m => m.row === cell.row && m.col === cell.col);
    if (!move) return;
    const movingType = state.board[from.row][from.col]?.type;
    const isCannonDrop = movingType === "20";
    const cannonCapture = isCannonDrop ? state.board[cell.row][cell.col] : null;
    state.enPassant = move.twoSquare ? { row: (from.row + move.row) / 2, col: move.col } : null;
    applyMoveOnBoard(state.board, from, cell, {
      recordCapture: !isCannonDrop, isEnPassant: move.isEnPassant,
      isPush: move.isPush,
      pushFromRow: move.pushFromRow, pushFromCol: move.pushFromCol,
      pushToRow:   move.pushToRow,   pushToCol:   move.pushToCol,
    });
    Sounds.play("place");
    if (state.online.active && window.Online) Online.emitMove(from, cell);
    state.selectedSquare = null;
    state.legalMoves = [];
    if (isCannonDrop) { _startCannonAnimation(from, cell, cannonCapture, () => endPlayTurn()); return; }
    endPlayTurn();
  }
}

function handleBoardClick(row, col) {
  if (state.phase === PH_KING_PLACE) {
    const player = state.current;
    if (state.kingsPlaced[player]) return;
    if (!canPlaceKingAt(player, row, col)) return;
    state.board[row][col] = makePiece(player, "00", 0);
    state.kingsPlaced[player] = true;
    Sounds.play("place");
    if (state.online.active && window.Online) Online.emitKingPlace(row, col, 0);
    nextPlayerOrAdvance();
    return;
  }
  if (state.phase === PH_SETUP) {
    const player = state.current;
    if (state.setupDone[player]) return;
    const idx = state.selectedHotbarIdx[player];
    if (idx === null) return;
    const type = state.hotbars[player][idx];
    if (state.budgets[player] < PIECE_INFO[type].cost) return;
    if (state.stars[player] <= 0) return;
    if (!canPlacePieceAt(player, row, col)) return;
    state.board[row][col] = makePiece(player, type);
    state.budgets[player] -= PIECE_INFO[type].cost;
    state.stars[player]   -= 1;
    Sounds.play("place");
    if (state.online.active && window.Online) Online.emitPiecePlace(row, col, type, state.board[row][col].skin);
    recomputeSetupDoneAfterPlacement(player);
    advanceSetupTurn();
    return;
  }
  if (state.phase === PH_PLAY) {
    const sel = state.selectedSquare;
    const piece = state.board[row][col];
    if (sel) {
      const move = state.legalMoves.find(m => m.row === row && m.col === col);
      if (move) {
        const movingType2 = state.board[sel.row][sel.col]?.type;
        const isCannonClick = movingType2 === "20";
        const cannonCapture2 = isCannonClick ? state.board[row][col] : null;
        state.enPassant = move.twoSquare ? { row: (sel.row + move.row) / 2, col: move.col } : null;
        applyMoveOnBoard(state.board, sel, { row, col }, {
          recordCapture: !isCannonClick, isEnPassant: move.isEnPassant,
          isPush: move.isPush,
      pushFromRow: move.pushFromRow, pushFromCol: move.pushFromCol,
      pushToRow:   move.pushToRow,   pushToCol:   move.pushToCol,
        });
        Sounds.play("place");
        if (state.online.active && window.Online) Online.emitMove(sel, { row, col });
        state.selectedSquare = null;
        state.legalMoves = [];
        if (isCannonClick) { _startCannonAnimation(sel, { row, col }, cannonCapture2, () => endPlayTurn()); return; }
        endPlayTurn();
        return;
      }
      if (piece && piece.color === state.current) {
        Sounds.play("select");
        state.selectedSquare = { row, col };
        state.legalMoves = legalMoves(state.board, row, col);
        return;
      }
      state.selectedSquare = null;
      state.legalMoves = [];
      return;
    } else {
      if (piece && piece.color === state.current) {
        Sounds.play("select");
        state.selectedSquare = { row, col };
        state.legalMoves = legalMoves(state.board, row, col);
      }
    }
  }
}

// ============================================================
// Phase transitions
// ============================================================
function nextPlayerOrAdvance() {
  if (state.kingsPlaced[P1] && state.kingsPlaced[P2]) {
    state.phase = PH_SETUP;
    flipToPlayer(P1, () => { state.message = ""; drawAll(); });
    return;
  }
  const next = 1 - state.current;
  flipToPlayer(next, () => { state.message = ""; drawAll(); });
}

function advanceSetupTurn() {
  // Defensive: recompute done-flags in case any state was missed
  for (const pl of [P1, P2]) {
    if (!canAffordAny(pl)) {
      state.setupDone[pl] = true;
      state.selectedHotbarIdx[pl] = null;
    }
  }

  if (state.setupDone[P1] && state.setupDone[P2]) { startPlay(); return; }

  // If current player is still able to play → other player's turn (alternation)
  // If current player is done → flip to the (not-done) other player
  // If only the next is done → stay on current
  const next = 1 - state.current;
  if (state.setupDone[state.current] && !state.setupDone[next]) {
    flipToPlayer(next, () => drawAll());
  } else if (state.setupDone[next]) {
    flipToPlayer(state.current, () => drawAll());
  } else {
    flipToPlayer(next, () => drawAll());
  }
}

function onFinishClicked() {
  if (state.phase !== PH_SETUP) return;
  const player = state.current;
  if (state.setupDone[player]) return;
  state.setupDone[player] = true;
  state.selectedHotbarIdx[player] = null;
  if (state.online.active && window.Online) Online.emitFinishSetup();
  advanceSetupTurn();
}

function startPlay() {
  state.phase = PH_PLAY;
  state.enPassant = null;
  state.selectedHotbarIdx = [null, null];
  flipToPlayer(P1, () => {
    // If a king is already under attack before the first move, that player loses instantly
    for (const color of [P1, P2]) {
      if (isInCheck(state.board, color)) {
        state.winner = 1 - color;
        const loserName  = color  === P1 ? "Player 1 (Orange)" : "Player 2 (Blue)";
        const winnerName = (1-color) === P1 ? "Player 1 (Orange)" : "Player 2 (Blue)";
        showEndScreen("Instant Loss!", `${loserName}'s King is immediately in check — ${winnerName} wins!`);
        state.phase = PH_END;
        drawAll();
        return;
      }
    }
    state.message = "Du bist am Zug.";
    drawAll();
    checkGameOver();
  });
}

// ── Kanonkugel-Animation: smooth travel from A → B ───────────────────────────
// capturedPiece: die geschlagene Figur (oder null) — wird erst am Ziel aus dem Spiel genommen
function _startCannonAnimation(from, to, capturedPiece, onDone) {
  const fromPos = cellToCanvas(from.row, from.col);
  const toPos   = cellToCanvas(to.row,   to.col);
  state.cannonAnim = {
    fromX: fromPos.x, fromY: fromPos.y,
    toX:   toPos.x,   toY:   toPos.y,
    toRow: to.row, toCol: to.col,
    capturedPiece,           // bleibt sichtbar bis Kugel ankommt
    startTime: performance.now(),
  };
  state.animating = true;
  function tick(now) {
    if (!state.cannonAnim) return;
    const progress = Math.min((now - state.cannonAnim.startTime) / CANNON_ANIM_MS, 1);
    drawAll();
    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      // Jetzt erst die geschlagene Figur ins Grab legen
      if (capturedPiece) state.captured[capturedPiece.color].push({ ...capturedPiece });
      state.cannonAnim = null;
      state.animating = false;
      onDone();
    }
  }
  requestAnimationFrame(tick);
}

function endPlayTurn() {
  const next = 1 - state.current;
  flipToPlayer(next, () => { drawAll(); checkGameOver(); });
}

function onlyKingsLeft(board) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board[r][c];
    if (p && p.type !== "00") return false;
  }
  return true;
}

function checkGameOver() {
  // Draw: only the two kings remain
  if (onlyKingsLeft(state.board)) {
    showEndScreen("Draw", "Only Kings remain — it's a draw.");
    state.phase = PH_END;
    drawAll();
    return;
  }
  const has = hasAnyLegalMove(state.board, state.current);
  if (!has) {
    if (isInCheck(state.board, state.current)) {
      state.winner = 1 - state.current;
      if (state.online.active) {
        const iWon = state.winner === state.online.myColor;
        showEndScreen("Checkmate!", iWon ? "You win!" : `${state.online.opponentName} wins!`);
      } else {
        showEndScreen("Checkmate!", `${state.winner === P1 ? "Player 1 (Orange)" : "Player 2 (Blue)"} wins!`);
      }
    } else {
      showEndScreen("Stalemate", "Draw — no legal moves.");
    }
    state.phase = PH_END;
    drawAll();
  }
}

function showEndScreen(title, text) {
  document.getElementById("end-title").textContent = title;
  document.getElementById("end-text").textContent = text;
  document.getElementById("end-overlay").classList.remove("hidden");
}

// ============================================================
// Flip animation — interpolates each piece's position so they stay upright
// ============================================================
function easeInOutQuad(t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2; }

function flipToPlayer(targetPlayer, onDone) {
  // Clear hover when transitioning — current selection / valid cells change
  state.hoverCell = null;
  _boardZoomMap.clear(); _boardZoomTarget = null; hoverZoomHotbarSlot = null;
  _hoverPreviewCell = null; _hoverPreviewMoves = null;

  // ONLINE: each device keeps its own fixed perspective — skip the flip animation entirely
  if (state.online.active) {
    state.current = targetPlayer;
    drawAll();
    onDone && onDone();
    return;
  }

  const wantFlipped = (targetPlayer === P2);
  if (wantFlipped === state.viewFlipped) {
    state.current = targetPlayer;
    drawAll();
    onDone && onDone();
    return;
  }
  const oldFlipped = state.viewFlipped;
  // Snapshot piece positions and target positions
  const pieces = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p) continue;
    pieces.push({
      p,
      from: cellPos(r, c, oldFlipped),
      to:   cellPos(r, c, wantFlipped),
    });
  }
  state.flipAnim = {
    pieces,
    start: performance.now(),
    duration: FLIP_DURATION_MS,
    newFlipped: wantFlipped,
    target: targetPlayer,
    onDone,
  };
  state.animating = true;
  // Hide markers / hotbar during animation
  drawHotbar();
  drawHud();
  requestAnimationFrame(flipAnimFrame);
}

function flipAnimFrame(now) {
  const a = state.flipAnim;
  if (!a) return;
  let t = (now - a.start) / a.duration;
  if (t > 1) t = 1;
  const e = easeInOutQuad(t);

  const _s = state.scale * _dpr();
  boardCtx.setTransform(1, 0, 0, 1, 0, 0);
  boardCtx.scale(_s, _s);
  boardCtx.imageSmoothingEnabled = false;
  boardCtx.clearRect(0, 0, BOARD_W, BOARD_H);
  boardCtx.drawImage(images["images/chessBoard.png"], 0, 0);

  for (const item of a.pieces) {
    const x = item.from.x + (item.to.x - item.from.x) * e;
    const y = item.from.y + (item.to.y - item.from.y) * e;
    const rx = Math.round(x), ry = Math.round(y);
    const img = images[pieceFile(item.p)];
    if (img) boardCtx.drawImage(img, rx + (item.p.type === "20" ? Math.floor((CELL - 12) / 2) + 0.5 : 0), ry + (item.p.type === "20" ? PIECE_VISUAL_OFFSET_Y + 10 : 0));
    if (item.p.type !== "20") drawWappenOnPiece(boardCtx, rx, ry, item.p.type, item.p.color, item.p.skin);
  }

  if (fancyGraphics && fancyGlow) {
    for (const item of a.pieces) {
      const x = item.from.x + (item.to.x - item.from.x) * e;
      const y = item.from.y + (item.to.y - item.from.y) * e;
      _drawPieceGlow(boardCtx, x + CELL / 2, y + CELL * 0.62, item.p.color, item.p.type === "00");
    }
  }

  if (t < 1) {
    requestAnimationFrame(flipAnimFrame);
  } else {
    state.viewFlipped = a.newFlipped;
    state.current = a.target;
    state.flipAnim = null;
    state.animating = false;
    drawAll();
    a.onDone && a.onDone();
  }
}

// ============================================================
// Init
// ============================================================
function generateHotbar() {
  const arr = [...HOTBAR_TYPES];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 4);
}

function resetGame() {
  state.phase = PH_KING_PLACE;
  state.current = P1;
  state.viewFlipped = false;
  state.board = createEmptyBoard();
  state.budgets = [BUDGET, BUDGET];
  state.stars   = [STAR_BUDGET, STAR_BUDGET];
  state.hotbars = [loadCustomHotbar(0), loadCustomHotbar(1)];
  state.selectedHotbarIdx = [null, null];
  state.selectedSquare = null;
  state.legalMoves = [];
  state.kingsPlaced = [false, false];
  state.setupDone = [false, false];
  state.animating = false;
  state.flipAnim = null;
  state.cannonAnim = null;
  state.message = "";
  state.winner = null;
  state.pointer = null;
  state.hoverCell = null;
  state.enPassant = null;
  _boardZoomMap.clear(); _boardZoomTarget = null;
  _hotbarZoomProgress = 0; hoverZoomHotbarSlot = null;
  _hoverPreviewCell = null; _hoverPreviewMoves = null;
  state.captured = [[], []];
  state.online = { active: false, myColor: null, opponentName: "" };
  wappenByColor = [wappenData, wappenData];
  setDragOverlay(false, "");
  document.getElementById("end-overlay").classList.add("hidden");
  document.getElementById("disconnect-overlay").classList.add("hidden");
  document.getElementById("resign-modal").classList.add("hidden");
  drawAll();
}

// ============================================================
// ── Settings persistence ─────────────────────────────────────
const SETTINGS_STORAGE_KEY = "tnm_settings_v1";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (typeof s.dragTilt        === "boolean") dragTilt        = s.dragTilt;
    if (typeof s.fancyGraphics   === "boolean") fancyGraphics   = s.fancyGraphics;
    if (typeof s.fancyShadows    === "boolean") fancyShadows    = s.fancyShadows;
    if (typeof s.fancySway       === "boolean") fancySway       = s.fancySway;
    if (typeof s.fancyHoverZoom  === "boolean") fancyHoverZoom  = s.fancyHoverZoom;
    if (typeof s.fancyGlow       === "boolean") fancyGlow       = s.fancyGlow;
    if (typeof s.fancyGlowMarkers=== "boolean") fancyGlowMarkers= s.fancyGlowMarkers;
    if (typeof s.pixelShadows    === "boolean") pixelShadows    = s.pixelShadows;
  } catch (_) {}
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      dragTilt, fancyGraphics, fancyShadows, fancySway,
      fancyHoverZoom, fancyGlow, fancyGlowMarkers, pixelShadows,
    }));
  } catch (_) {}
}

// ============================================================
// Wappen (Coat of Arms) — pixel editor + board overlay
// ============================================================
const WAPPEN_STORAGE_KEY = "tnm_wappen_v1";
const WAPPEN_KING_COLS  = 4;
const WAPPEN_KING_ROWS  = 4;
const WAPPEN_PIECE_COLS = 3;
const WAPPEN_PIECE_ROWS = 3;

// 1 = drawable cell, 0 = disabled (outside shield silhouette)
const WAPPEN_MASK_KING = [
  [1,1,1,1],
  [1,1,1,1],
  [1,1,1,1],
  [0,1,1,0],
];
const WAPPEN_MASK_PIECE = [
  [1,1,1],
  [1,1,1],
  [0,1,0],
];

let wappenData = {
  king:  Array.from({length: WAPPEN_KING_ROWS},  () => Array(WAPPEN_KING_COLS).fill(null)),
  piece: Array.from({length: WAPPEN_PIECE_ROWS}, () => Array(WAPPEN_PIECE_COLS).fill(null)),
};
// In online mode index 0/1 hold P1/P2 wappens; offline both point to the same local data.
let wappenByColor = [wappenData, wappenData];

function loadWappen() {
  try {
    const raw = localStorage.getItem(WAPPEN_STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (Array.isArray(d.king)  && d.king.length  === WAPPEN_KING_ROWS)  wappenData.king  = d.king;
    if (Array.isArray(d.piece) && d.piece.length === WAPPEN_PIECE_ROWS) wappenData.piece = d.piece;
  } catch (_) {}
}
function saveWappen() {
  try { localStorage.setItem(WAPPEN_STORAGE_KEY, JSON.stringify(wappenData)); } catch (_) {}
}

// Called by online.js at game start to inject the opponent's wappen.
window.setOnlineWappens = function(myColor, opponentWappen) {
  wappenByColor[myColor]     = wappenData;
  wappenByColor[1 - myColor] = opponentWappen || wappenData;
};
// Reset to local-only when game ends / resets.
window.resetWappenByColor = function() {
  wappenByColor = [wappenData, wappenData];
};

// Per-type wappen anchor (top-left of badge, in logical px within 23×23 sprite).
// King ("00") and Acrobat ("12") fall back to centered calculation.
const WAPPEN_POS_X = { "00":9,"01":11,"02":10,"03":9,"04":10,"05":11,"06":11,"10":8,"11":11,"12":12 };
const WAPPEN_POS_Y = { "00":12,"01":14,"02":14,"03":14,"04":11,"05":12,"06":16,"10":14,"11":18,"12":13 };

// Per-skin overrides — key: "type_skin" — only needed where sprite layout differs
const WAPPEN_POS_SKIN_X = { "05_5": 12 };
const WAPPEN_POS_SKIN_Y = { "05_5": 14 };

function _wappenOffset(type, cols, rows, px, spriteScale, skin) {
  // spriteScale: multiply logical px → sprite-canvas px (pass 1 for board-logical)
  const skinKey = `${type}_${skin}`;
  const posX = WAPPEN_POS_SKIN_X[skinKey] ?? WAPPEN_POS_X[type];
  const posY = WAPPEN_POS_SKIN_Y[skinKey] ?? WAPPEN_POS_Y[type];
  if (posX !== undefined) {
    return {
      ox: Math.round(posX * spriteScale),
      oy: Math.round(posY * spriteScale),
    };
  }
  // Fallback: centered (used for King "00" and Acrobat "12")
  const total = Math.round(CELL * spriteScale);
  return {
    ox: Math.round((total - cols * px) / 2),
    oy: Math.round((total - rows * px) / 2) - px,
  };
}

// Non-fancy path: draw in logical px directly on the board canvas
function drawWappenOnPiece(ctx, imgX, imgY, type, pieceColor = 0, skin = 0) {
  const isKing = type === "00";
  const wd = wappenByColor[pieceColor] || wappenData;
  const data = isKing ? wd.king  : wd.piece;
  const mask = isKing ? WAPPEN_MASK_KING : WAPPEN_MASK_PIECE;
  const cols = isKing ? WAPPEN_KING_COLS : WAPPEN_PIECE_COLS;
  const rows = isKing ? WAPPEN_KING_ROWS : WAPPEN_PIECE_ROWS;
  const { ox, oy } = _wappenOffset(type, cols, rows, 1, 1, skin);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r][c]) continue;
      const color = data[r][c];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(imgX + ox + c, imgY + oy + r, 1, 1);
    }
  }
}

// Fancy path: bake wappen onto the pre-rendered sprite canvas so it inherits
// shadow, sway and zoom transforms automatically.
function _drawWappenOnSprite(sCtx, spriteSize, type, pieceColor = 0, skin = 0) {
  const isKing = type === "00";
  const wd = wappenByColor[pieceColor] || wappenData;
  const data = isKing ? wd.king  : wd.piece;
  const mask = isKing ? WAPPEN_MASK_KING : WAPPEN_MASK_PIECE;
  const cols = isKing ? WAPPEN_KING_COLS : WAPPEN_PIECE_COLS;
  const rows = isKing ? WAPPEN_KING_ROWS : WAPPEN_PIECE_ROWS;
  const px   = Math.max(1, Math.round(spriteSize / CELL));
  const scale = spriteSize / CELL;
  const { ox, oy } = _wappenOffset(type, cols, rows, px, scale, skin);
  sCtx.imageSmoothingEnabled = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r][c]) continue;
      const color = data[r][c];
      if (!color) continue;
      sCtx.fillStyle = color;
      sCtx.fillRect(ox + c * px, oy + r * px, px, px);
    }
  }
}

function initWappenEditor() {
  const overlay  = document.getElementById("wappen-config");
  const openBtn  = document.getElementById("wappen-config-btn");
  const closeBtn = document.getElementById("wc-close");
  const svCanvas  = document.getElementById("wc-sv");
  const hueCanvas = document.getElementById("wc-hue");
  const hexInput  = document.getElementById("wc-hex");
  const previewEl = document.getElementById("wc-preview");
  const eraserBtn = document.getElementById("wc-eraser");
  const kingCanvas  = document.getElementById("wc-king");
  const pieceCanvas = document.getElementById("wc-piece");

  const svCtx    = svCanvas.getContext("2d");
  const hueCtx   = hueCanvas.getContext("2d");
  const kingCtx  = kingCanvas.getContext("2d");
  const pieceCtx = pieceCanvas.getContext("2d");

  // ── Picker state ────────────────────────────────────────────
  let pH = 0, pS = 1, pV = 0.5, erasing = false;

  function hsv2rgb(h, s, v) {
    const c = v*s, x = c*(1-Math.abs((h/60)%2-1)), m = v-c;
    let r,g,b;
    if      (h<60)  {r=c;g=x;b=0;}
    else if (h<120) {r=x;g=c;b=0;}
    else if (h<180) {r=0;g=c;b=x;}
    else if (h<240) {r=0;g=x;b=c;}
    else if (h<300) {r=x;g=0;b=c;}
    else            {r=c;g=0;b=x;}
    return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
  }
  function rgb2hsv(r,g,b) {
    r/=255;g/=255;b/=255;
    const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
    let h=0,s=max?d/max:0,v=max;
    if(d){if(max===r)h=((g-b)/d+6)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;}
    return [h,s,v];
  }
  function currentHex() {
    const [r,g,b] = hsv2rgb(pH,pS,pV);
    return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  function updatePreview() {
    if (erasing) {
      previewEl.style.background = "repeating-conic-gradient(#3a2a4a 0% 25%,#1a1422 0% 50%)";
      previewEl.style.backgroundSize = "10px 10px";
    } else {
      previewEl.style.background = currentHex();
      previewEl.style.backgroundSize = "";
    }
    if (!erasing) hexInput.value = currentHex().toUpperCase();
  }

  // ── SV square ───────────────────────────────────────────────
  function drawSV() {
    const w=svCanvas.width, h=svCanvas.height;
    const [hr,hg,hb] = hsv2rgb(pH,1,1);
    const gH = svCtx.createLinearGradient(0,0,w,0);
    gH.addColorStop(0,'#fff'); gH.addColorStop(1,`rgb(${hr},${hg},${hb})`);
    svCtx.fillStyle = gH; svCtx.fillRect(0,0,w,h);
    const gV = svCtx.createLinearGradient(0,0,0,h);
    gV.addColorStop(0,'rgba(0,0,0,0)'); gV.addColorStop(1,'rgba(0,0,0,1)');
    svCtx.fillStyle = gV; svCtx.fillRect(0,0,w,h);
    // crosshair cursor
    const cx=pS*w, cy=(1-pV)*h;
    svCtx.beginPath(); svCtx.arc(cx,cy,5,0,Math.PI*2);
    svCtx.strokeStyle='#fff'; svCtx.lineWidth=2; svCtx.stroke();
    svCtx.beginPath(); svCtx.arc(cx,cy,5,0,Math.PI*2);
    svCtx.strokeStyle='rgba(0,0,0,0.6)'; svCtx.lineWidth=1; svCtx.stroke();
  }
  // ── Hue strip ───────────────────────────────────────────────
  function drawHue() {
    const w=hueCanvas.width, h=hueCanvas.height;
    const g=hueCtx.createLinearGradient(0,0,w,0);
    for(let i=0;i<=6;i++) g.addColorStop(i/6,`hsl(${i*60},100%,50%)`);
    hueCtx.fillStyle=g; hueCtx.fillRect(0,0,w,h);
    const cx=pH/360*w;
    hueCtx.strokeStyle='#fff'; hueCtx.lineWidth=2;
    hueCtx.beginPath(); hueCtx.moveTo(cx,0); hueCtx.lineTo(cx,h); hueCtx.stroke();
    hueCtx.strokeStyle='rgba(0,0,0,0.4)'; hueCtx.lineWidth=1;
    hueCtx.beginPath(); hueCtx.moveTo(cx,0); hueCtx.lineTo(cx,h); hueCtx.stroke();
  }
  function redrawPicker() { drawSV(); drawHue(); updatePreview(); }

  // ── Drag helper ─────────────────────────────────────────────
  function addDrag(el, fn) {
    let down=false;
    el.addEventListener("pointerdown",e=>{down=true;el.setPointerCapture(e.pointerId);fn(e);});
    el.addEventListener("pointermove",e=>{if(down)fn(e);});
    el.addEventListener("pointerup",()=>{down=false;});
  }
  addDrag(svCanvas, e=>{
    const r=svCanvas.getBoundingClientRect();
    pS=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
    pV=Math.max(0,Math.min(1,1-(e.clientY-r.top)/r.height));
    erasing=false; eraserBtn.classList.remove("wc-eraser-on");
    redrawPicker();
  });
  addDrag(hueCanvas, e=>{
    const r=hueCanvas.getBoundingClientRect();
    pH=Math.max(0,Math.min(359.99,(e.clientX-r.left)/r.width*360));
    erasing=false; eraserBtn.classList.remove("wc-eraser-on");
    redrawPicker();
  });
  hexInput.addEventListener("input", ()=>{
    const v=hexInput.value.trim();
    if(/^#[0-9a-fA-F]{6}$/.test(v)){
      [pH,pS,pV]=rgb2hsv(parseInt(v.slice(1,3),16),parseInt(v.slice(3,5),16),parseInt(v.slice(5,7),16));
      erasing=false; eraserBtn.classList.remove("wc-eraser-on");
      redrawPicker();
    }
  });
  eraserBtn.addEventListener("click",()=>{
    erasing=!erasing;
    eraserBtn.classList.toggle("wc-eraser-on",erasing);
    updatePreview();
  });

  // ── Drawing canvases ────────────────────────────────────────
  const CELL_PX = 30; // editor grid cell size in CSS px (large = easy to click tiny grids)

  function redrawGrid(ctx, canvas, data, mask, cols, rows) {
    const w=cols*CELL_PX, h=rows*CELL_PX;
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    ctx.clearRect(0,0,w,h);
    for(let r=0;r<rows;r++){
      for(let c=0;c<cols;c++){
        const x=c*CELL_PX, y=r*CELL_PX;
        if(!mask[r][c]){
          // Disabled: dark checkerboard
          ctx.fillStyle=(r+c)%2===0?"#1e1828":"#171220";
          ctx.fillRect(x,y,CELL_PX,CELL_PX);
        } else {
          ctx.fillStyle=data[r][c]||"#2a2035";
          ctx.fillRect(x,y,CELL_PX,CELL_PX);
        }
        // Grid line
        ctx.strokeStyle="rgba(0,0,0,0.55)";
        ctx.lineWidth=0.75;
        ctx.strokeRect(x+0.375,y+0.375,CELL_PX-0.75,CELL_PX-0.75);
      }
    }
  }
  function redrawEditors() {
    redrawGrid(kingCtx, kingCanvas, wappenData.king,  WAPPEN_MASK_KING,  WAPPEN_KING_COLS,  WAPPEN_KING_ROWS);
    redrawGrid(pieceCtx,pieceCanvas,wappenData.piece, WAPPEN_MASK_PIECE, WAPPEN_PIECE_COLS, WAPPEN_PIECE_ROWS);
  }

  function paintCell(canvas, data, mask, cols, rows, cx, cy) {
    const rect=canvas.getBoundingClientRect();
    const c=Math.floor((cx-rect.left)/rect.width*cols);
    const r=Math.floor((cy-rect.top)/rect.height*rows);
    if(c<0||c>=cols||r<0||r>=rows||!mask[r][c]) return;
    const color = erasing ? null : currentHex();
    if(data[r][c]===color) return;
    data[r][c]=color;
    saveWappen(); redrawEditors(); drawAll();
  }
  addDrag(kingCanvas,  e=>paintCell(kingCanvas, wappenData.king, WAPPEN_MASK_KING,
    WAPPEN_KING_COLS, WAPPEN_KING_ROWS, e.clientX, e.clientY));
  addDrag(pieceCanvas, e=>paintCell(pieceCanvas,wappenData.piece,WAPPEN_MASK_PIECE,
    WAPPEN_PIECE_COLS,WAPPEN_PIECE_ROWS,e.clientX,e.clientY));

  document.getElementById("wc-clear-king").addEventListener("click",()=>{
    wappenData.king=Array.from({length:WAPPEN_KING_ROWS},()=>Array(WAPPEN_KING_COLS).fill(null));
    saveWappen();redrawEditors();drawAll();
  });
  document.getElementById("wc-clear-piece").addEventListener("click",()=>{
    wappenData.piece=Array.from({length:WAPPEN_PIECE_ROWS},()=>Array(WAPPEN_PIECE_COLS).fill(null));
    saveWappen();redrawEditors();drawAll();
  });

  // ── Open / close ────────────────────────────────────────────
  function open() {
    redrawEditors(); redrawPicker();
    overlay.classList.remove("hidden");
    requestAnimationFrame(()=>requestAnimationFrame(()=>overlay.classList.add("visible")));
  }
  function close() {
    overlay.classList.remove("visible");
    overlay.addEventListener("transitionend",()=>overlay.classList.add("hidden"),{once:true});
  }
  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", e=>{ if(e.target===overlay) close(); });
}

// Hotbar Configuration (start-screen picker, persisted to localStorage)
// ============================================================
const HC_STORAGE_KEY   = "tnm_hotbar_v1";      // P1 (keeps backward-compat)
const HC_STORAGE_KEY_P2 = "tnm_hotbar_p2_v1"; // P2
const HC_TYPES = ["01", "02", "03", "04", "05", "10", "11", "12", "20"];
const HC_NAMES = {
  "01": "Pawn", "02": "Bishop", "03": "Knight",
  "04": "Rook", "05": "Queen",  "10": "Blocker", "11": "Sumo Wrestler",
  "12": "Acrobat",
};
const HC_DESCRIPTIONS = {
  "01": "1 step fwd.\nCaptures diagonally",
  "02": "Slides diagonally\nany distance",
  "03": "L-shaped jump\nLeaps over pieces",
  "04": "Slides straight\nany distance",
  "05": "Slides in all\ndirections",
  "10": "1 step in any direction\n(like a King).\nImmune to straight attacks",
  "11": "1–2 steps straight\nor 1 diagonal.\nPushes pieces behind target",
  "12": "Jumps over any piece\nlands 1 step beyond it",
  "20": "Rolls straight forward\nto the last open square.\nCaptures 1st enemy at end",
};

// Tooltip shown on hover over opponent's special pieces during setup
const PIECE_TOOLTIP_DESC = {
  "06": "Double Pawn — moves 1–2 fwd, can lance through own piece to capture",
  "10": "Blocker — moves 1 step in any direction (like a King), immune to straight attacks",
  "11": "Sumo Wrestler — 1–2 straight or 1 diagonal, pushes the piece behind the target",
  "12": "Acrobat — jumps over any piece and lands 1 step behind it",
  "20": "Cannonball — rolls forward to the last open square, captures first enemy it hits",
};

function loadCustomHotbar(player = 0) {
  const key = player === 1 ? HC_STORAGE_KEY_P2 : HC_STORAGE_KEY;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length === 4 && arr.every(t => HC_TYPES.includes(t))) return arr;
    }
  } catch (_) {}
  return ["01", "02", "03", "04"]; // sensible default
}

function saveCustomHotbar(arr, player = 0) {
  const key = player === 1 ? HC_STORAGE_KEY_P2 : HC_STORAGE_KEY;
  try { localStorage.setItem(key, JSON.stringify(arr)); } catch (_) {}
}

function initHotbarConfig() {
  const overlay   = document.getElementById("hotbar-config");
  const openBtn   = document.getElementById("hotbar-config-btn");
  const closeBtn  = document.getElementById("hc-close");
  const randomBtn = document.getElementById("hc-random-btn");
  const gallery   = document.getElementById("hc-gallery");
  const slotsEl   = document.getElementById("hc-slots");
  const tabP1     = document.getElementById("hc-tab-p1");
  const tabP2     = document.getElementById("hc-tab-p2");

  let activePlayer = 0;                        // 0 = P1, 1 = P2
  let hotbar   = loadCustomHotbar(activePlayer); // working copy
  let selected = null;                           // piece type chosen in gallery

  function switchTab(player) {
    saveCustomHotbar(hotbar, activePlayer);   // save current before switching
    state.hotbars[activePlayer] = [...hotbar];
    activePlayer = player;
    hotbar   = loadCustomHotbar(activePlayer);
    selected = null;
    tabP1.classList.toggle("hc-tab-active", player === 0);
    tabP2.classList.toggle("hc-tab-active", player === 1);
    overlay.querySelector(".hc-panel").classList.toggle("hc-p2", player === 1);
    render();
  }
  tabP1.addEventListener("click", () => { Sounds.play("click"); switchTab(0); });
  tabP2.addEventListener("click", () => { Sounds.play("click"); switchTab(1); });

  function open() {
    activePlayer = 0;
    hotbar   = loadCustomHotbar(0);
    selected = null;
    tabP1.classList.add("hc-tab-active");
    tabP2.classList.remove("hc-tab-active");
    overlay.querySelector(".hc-panel").classList.remove("hc-p2");
    render();
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("visible")));
  }

  function close() {
    saveCustomHotbar(hotbar, activePlayer);
    state.hotbars[activePlayer] = [...hotbar];
    overlay.classList.remove("visible");
    overlay.addEventListener("transitionend", () => overlay.classList.add("hidden"), { once: true });
  }

  function render() { renderGallery(); renderSlots(); }

  function renderGallery() {
    gallery.innerHTML = "";
    for (const type of HC_TYPES) {
      const tile = document.createElement("div");
      tile.className = "hc-tile" + (selected === type ? " hc-selected" : "");

      const img = document.createElement("img");
      img.src = type === "20" ? "images/figures/2000.png" : `images/figures/${activePlayer}${type}0.png`;
      img.alt = HC_NAMES[type];

      const name = document.createElement("div");
      name.className = "hc-tile-name";
      name.textContent = HC_NAMES[type];

      const cost = document.createElement("div");
      cost.className = "hc-tile-cost";
      cost.textContent = PIECE_INFO[type].cost + " ⚙";

      const desc = document.createElement("div");
      desc.className = "hc-tile-desc";
      desc.textContent = HC_DESCRIPTIONS[type] || "";

      tile.draggable = true;
      tile.append(img, name, cost, desc);
      tile.addEventListener("click", () => {
        Sounds.play("click");
        selected = (selected === type) ? null : type;
        renderGallery();
        renderSlots();
      });
      tile.addEventListener("dragstart", e => {
        e.dataTransfer.setData("hc-type", type);
        e.dataTransfer.effectAllowed = "copy";
      });
      gallery.appendChild(tile);
    }
  }

  function renderSlots() {
    slotsEl.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      const type = hotbar[i];
      const slot = document.createElement("div");
      slot.className = "hc-slot" + (selected ? " hc-drop-target" : "");

      const num = document.createElement("div");
      num.className = "hc-slot-num";
      num.textContent = "Slot " + (i + 1);

      const img = document.createElement("img");
      img.src = type === "20" ? "images/figures/2000.png" : `images/figures/${activePlayer}${type}0.png`;
      img.alt = HC_NAMES[type];

      const cost = document.createElement("div");
      cost.className = "hc-slot-cost";
      cost.textContent = PIECE_INFO[type].cost + " ⚙";

      slot.append(num, img, cost);
      slot.addEventListener("dragover", e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        slot.classList.add("hc-drag-over");
      });
      slot.addEventListener("dragleave", () => slot.classList.remove("hc-drag-over"));
      slot.addEventListener("drop", e => {
        e.preventDefault();
        slot.classList.remove("hc-drag-over");
        const type = e.dataTransfer.getData("hc-type");
        if (!type) return;
        Sounds.play("select");
        hotbar[i] = type;
        selected = null;
        slot.classList.add("hc-bounce");
        slot.addEventListener("animationend", () => slot.classList.remove("hc-bounce"), { once: true });
        render();
      });
      slot.addEventListener("click", () => {
        Sounds.play("click");
        if (selected) {
          // Assign the selected piece to this slot
          hotbar[i] = selected;
          selected = null;
          slot.classList.add("hc-bounce");
          slot.addEventListener("animationend", () => slot.classList.remove("hc-bounce"), { once: true });
          render();
        } else {
          // No piece selected → cycle through types
          const idx = HC_TYPES.indexOf(hotbar[i]);
          hotbar[i] = HC_TYPES[(idx + 1) % HC_TYPES.length];
          slot.classList.add("hc-bounce");
          slot.addEventListener("animationend", () => slot.classList.remove("hc-bounce"), { once: true });
          renderSlots();
        }
      });
      slotsEl.appendChild(slot);
    }
  }

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  randomBtn.addEventListener("click", () => {
    hotbar = generateHotbar();
    selected = null;
    render();
    saveCustomHotbar(hotbar, activePlayer);
    state.hotbars[activePlayer] = [...hotbar];
  });

  // Close on backdrop click
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

async function main() {
  await preload();
  // Canvas sizes are set by applyBoardCanvasMode() → called via updateScale() below.
  boardCanvas.addEventListener("pointerdown", onPointerDown);
  hotbarCanvas.addEventListener("pointerdown", onPointerDown);
  boardCanvas.addEventListener("pointermove", onBoardHoverMove);
  boardCanvas.addEventListener("pointerleave", onBoardHoverLeave);
  hotbarCanvas.addEventListener("pointermove", onHotbarHoverMove);
  hotbarCanvas.addEventListener("pointerleave", () => _clearHotbarHoverZoom());
  document.getElementById("finish-btn").addEventListener("click", onFinishClicked);
  document.getElementById("restart-btn").addEventListener("click", () => {
    // Online mode is intercepted by online.js (capture listener fires first)
    // Local mode: fly all buttons back up and return to start screen
    resetGame();
    document.getElementById("stage-wrapper").classList.remove("visible");

    const startScreen = document.getElementById("start-screen");
    startScreen.classList.remove("hidden");
    startScreen.style.opacity      = "";
    startScreen.style.pointerEvents = "";

    const btnIds = ["play-btn", "play-online-btn", "hotbar-config-btn", "wappen-config-btn"];
    requestAnimationFrame(() => {
      for (const id of btnIds) document.getElementById(id).classList.remove("fly-down");
      requestAnimationFrame(() => {
        for (const id of btnIds) {
          const b = document.getElementById(id);
          b.classList.add("fly-up");
          b.addEventListener("animationend", () => b.classList.remove("fly-up"), { once: true });
        }
      });
    });
  });

  const resignModal   = document.getElementById("resign-modal");
  const resignConfirm = document.getElementById("resign-confirm-btn");
  const resignCancel  = document.getElementById("resign-cancel-btn");

  document.getElementById("resign-btn").addEventListener("click", () => {
    if (state.phase === PH_END) return;
    resignModal.classList.remove("hidden");
  });

  resignCancel.addEventListener("click", () => {
    resignModal.classList.add("hidden");
  });

  resignConfirm.addEventListener("click", () => {
    resignModal.classList.add("hidden");
    if (state.phase === PH_END) return;
    if (state.online.active) {
      if (window.Online && Online.emitResign) Online.emitResign();
    } else {
      const loser      = state.current;
      const winner     = 1 - loser;
      const loserName  = loser  === P1 ? "Player 1 (Orange)" : "Player 2 (Blue)";
      const winnerName = winner === P1 ? "Player 1 (Orange)" : "Player 2 (Blue)";
      state.phase = PH_END;
      drawAll();
      showEndScreen("Resignation!", `${loserName} resigns — ${winnerName} wins!`);
    }
  });

  // Wappen editor + Hotbar config
  loadWappen();
  initWappenEditor();
  initHotbarConfig();

  // Settings panel toggle
  const settingsPanel = document.getElementById("settings-panel");
  document.getElementById("settings-btn").addEventListener("click", () => {
    settingsPanel.classList.toggle("hidden");
  });
  document.getElementById("settings-close").addEventListener("click", () => {
    settingsPanel.classList.add("hidden");
  });

  // ── Fancy Graphics toggles ───────────────────────────────
  loadSettings();   // restore persisted values before wiring toggles

  const FANCY_FRAMES = 8;
  const FANCY_FPS    = 36;
  const fancySubGroup = document.getElementById("fancy-sub-options");

  // Generic helper: wire an On/Off toggle image to a getter/setter pair
  function makeFancyToggle(elemId, getValue, setValue) {
    const el = document.getElementById(elemId);
    // Apply initial visual state from loaded/default value
    el.classList.toggle("toggle-on", getValue());
    el.src = `images/On_Off_Button${getValue() ? 8 : 1}.png`;
    let animating = false;
    el.addEventListener("click", () => {
      if (animating) return;
      Sounds.play("click");
      animating = true;
      const forward   = !getValue();
      let frame       = forward ? 1 : FANCY_FRAMES;
      const lastFrame = forward ? FANCY_FRAMES : 1;
      const step      = forward ? 1 : -1;
      el.src = `images/On_Off_Button${frame}.png`;
      const iv = setInterval(() => {
        frame += step;
        el.src = `images/On_Off_Button${frame}.png`;
        if (frame === lastFrame) {
          clearInterval(iv);
          setValue(forward);
          el.classList.toggle("toggle-on", forward);
          animating = false;
        }
      }, 1000 / FANCY_FPS);
    });
  }

  // Sub-options: reflect actual startup state
  fancySubGroup.classList.toggle("fancy-disabled", !fancyGraphics);

  // Main Fancy Graphics toggle
  makeFancyToggle("fancy-toggle",
    () => fancyGraphics,
    (v) => {
      fancyGraphics = v;
      fancySubGroup.classList.toggle("fancy-disabled", !v);
      saveSettings();
      updateScale();   // decimal ↔ integer zoom + canvas resize
      drawAll();
    }
  );

  // Sub-option: Shadows
  const shadowsSubOptions = document.getElementById("fancy-shadows-sub-options");
  makeFancyToggle("fancy-shadows-toggle",
    () => fancyShadows,
    (v) => {
      fancyShadows = v;
      shadowsSubOptions.classList.toggle("fancy-disabled", !v);
      saveSettings(); drawBoard(); drawHotbar();
    }
  );
  makeFancyToggle("fancy-pixel-shadows-toggle",
    () => pixelShadows,
    (v) => { pixelShadows = v; saveSettings(); drawBoard(); drawHotbar(); }
  );

  // Sub-option: Schwanken
  makeFancyToggle("fancy-sway-toggle",
    () => fancySway,
    (v) => {
      fancySway = v;
      saveSettings();
      if (v) startSwayLoop();
      else { drawBoard(); if (fancyGlow && fancyGraphics) startGlowLoop(); }
    }
  );

  // Sub-option: Hover Zoom
  makeFancyToggle("fancy-hover-toggle",
    () => fancyHoverZoom,
    (v) => { fancyHoverZoom = v; saveSettings(); drawBoard(); }
  );

  // Sub-option: Glühen
  const glowSubOptions = document.getElementById("fancy-glow-sub-options");
  makeFancyToggle("fancy-glow-toggle",
    () => fancyGlow,
    (v) => {
      fancyGlow = v;
      glowSubOptions.classList.toggle("fancy-disabled", !v);
      saveSettings();
      if (v) startGlowLoop(); else { drawBoard(); drawHotbarGlow(); drawHotbar(); }
    }
  );
  makeFancyToggle("fancy-glow-markers-toggle",
    () => fancyGlowMarkers,
    (v) => { fancyGlowMarkers = v; saveSettings(); drawBoard(); }
  );

  // Apply initial loop/disabled states based on startup values
  shadowsSubOptions.classList.toggle("fancy-disabled", !fancyShadows);
  glowSubOptions.classList.toggle("fancy-disabled", !fancyGlow);
  if (fancyGraphics && fancySway) startSwayLoop();

  // Standalone: Drag Tilt
  makeFancyToggle("drag-tilt-toggle",
    () => dragTilt,
    (v) => {
      dragTilt = v;
      saveSettings();
      if (!v) {
        _dragTiltVX = 0; _dragTiltLastX = null; _dragTiltLastT = null;
        if (!state.animating) drawBoard();
      }
    }
  );

  // Start screen → Play button kicks off the game
  document.getElementById("play-btn").addEventListener("click", () => {
    const playBtn       = document.getElementById("play-btn");
    const playOnlineBtn = document.getElementById("play-online-btn");
    const startScreen   = document.getElementById("start-screen");
    const stageWrap     = document.getElementById("stage-wrapper");

    // 1) Fly all start-screen buttons downward together
    playBtn.classList.add("fly-down");
    playOnlineBtn.classList.add("fly-down");
    document.getElementById("hotbar-config-btn").classList.add("fly-down");
    document.getElementById("wappen-config-btn").classList.add("fly-down");

    playBtn.addEventListener("animationend", () => {
      // 2) Fade out the start screen overlay
      startScreen.classList.add("hidden");

      // 3) Start game logic immediately (so board is ready)
      resetGame();

      // 4) Fade in the stage after a tiny delay to let display update
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          stageWrap.classList.add("visible");
        });
      });
    }, { once: true });
  });
  // ── Full-screen drag canvas ──────────────────────────────────
  _dragCanvas = document.createElement("canvas");
  Object.assign(_dragCanvas.style, {
    position: "fixed", top: "0", left: "0",
    pointerEvents: "none", zIndex: "999",
    imageRendering: "pixelated",
  });
  document.body.appendChild(_dragCanvas);
  _dragCtx = _dragCanvas.getContext("2d");
  _updateDragCanvasSize();

  window.addEventListener("resize", () => { updateScale(); _updateDragCanvasSize(); drawAll(); });
  // Prevent default touch behaviors over canvases
  for (const el of [boardCanvas, hotbarCanvas]) {
    el.addEventListener("touchstart", e => e.preventDefault(), { passive: false });
  }
  // Log device pixel ratio so HiDPI/Retina scaling is visible in the console
  function _logDpr() {
    const dpr = _dpr();
    console.log(`[TheNextMove] devicePixelRatio = ${dpr}` +
      (dpr !== 1 ? ` — HiDPI display (${dpr}× physical pixels per CSS pixel, canvas upscaled accordingly)` : " — standard display"));
  }
  _logDpr();
  // Re-log + rebuild if the window moves to a display with a different DPR
  window.matchMedia(`(resolution: ${_dpr()}dppx)`).addEventListener("change", () => {
    _logDpr();
    updateScale();
    drawAll();
  });

  updateScale();
  // Don't start the game automatically — wait for the player to press Play
  // (the #start-screen overlay covers everything until then)

  // Wire up online module after everything is ready
  if (window.Online) Online.init();
}

main();
