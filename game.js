"use strict";

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

const BUDGET = 20;

// Fancy Graphics mode — toggled via Settings panel
// Canvas always stays at logical resolution (188×196); CSS handles the upscale.
// In fancy mode: CSS uses bilinear upscaling (image-rendering: auto) so that
// rotated/scaled sprites look smooth instead of blocky.
// In normal mode: CSS uses nearest-neighbour (image-rendering: pixelated).
let fancyGraphics  = false;
let fancyShadows   = false;   // sub-option: drop-shadow on every piece
let fancySway      = false;   // sub-option: pieces gently sway
let fancyHoverZoom = false;   // sub-option: hovered pieces grow slightly

// ── Hover zoom animation state ───────────────────────────────
const HOVER_ZOOM_TARGET   = 1.06;   // subtle max scale
const HOVER_ZOOM_DURATION = 0.20;   // seconds for full in/out transition
let hoverZoomProgress    = 0.0;    // 0.0 = normal, 1.0 = full zoom
let hoverZoomCell        = null;   // {row, col} board piece being zoomed
let hoverZoomHotbarSlot  = null;   // 0–3 hotbar slot being zoomed
let hoverZoomRAFId       = null;

// ── Drag-Tilt setting + state ────────────────────────────────
let dragTilt = true;
let _dragTiltVX       = 0;      // smoothed horizontal velocity (px/s)
let _dragTiltLastX    = null;
let _dragTiltLastT    = null;
let _dragTiltDecayRAF = null;
const DRAG_TILT_MAX   = 16;     // degrees
const DRAG_TILT_SCALE = 0.048;  // px/s → degrees

// ── Hover move-preview state (PH_PLAY: faint dots where hovered piece can go) ──
let _hoverPreviewCell  = null;   // {row, col} of the piece being previewed
let _hoverPreviewMoves = null;   // array of pseudo-move targets [{row,col,capture}, ...]

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
    if (!state.animating) drawBoard();
    swayRAFId = requestAnimationFrame(loop);
  });
}

function startHoverZoomLoop() {
  if (hoverZoomRAFId !== null) return;
  let lastTime = null;
  hoverZoomRAFId = requestAnimationFrame(function loop(now) {
    if (!fancyHoverZoom || !fancyGraphics) {
      hoverZoomProgress = 0; hoverZoomCell = null; hoverZoomHotbarSlot = null;
      hoverZoomRAFId = null;
      if (!state.animating) { drawBoard(); drawHotbar(); }
      return;
    }
    const dt = lastTime !== null ? (now - lastTime) / 1000 : 0.016;
    lastTime = now;
    const step = dt / HOVER_ZOOM_DURATION;
    const hasTarget = hoverZoomCell !== null || hoverZoomHotbarSlot !== null;
    hoverZoomProgress = hasTarget
      ? Math.min(1.0, hoverZoomProgress + step)
      : Math.max(0.0, hoverZoomProgress - step);
    if (!state.animating) { drawBoard(); drawHotbar(); }
    if ((hasTarget && hoverZoomProgress < 1.0) || (!hasTarget && hoverZoomProgress > 0.0)) {
      hoverZoomRAFId = requestAnimationFrame(loop);
    } else {
      hoverZoomRAFId = null;
    }
  });
}

const PIECE_INFO = {
  "00": { name: "König",       cost: 0, skins: 1  },
  "01": { name: "Bauer",       cost: 1, skins: 10 },
  "02": { name: "Bischof",     cost: 3, skins: 5  },
  "03": { name: "Pferd",       cost: 3, skins: 2  },
  "04": { name: "Turm",        cost: 5, skins: 1  },
  "05": { name: "Dame",        cost: 9, skins: 6  },
  "06": { name: "Doppelbauer", cost: 1, skins: 10 },
  "10": { name: "Blocker",     cost: 4, skins: 1  },
  "11": { name: "Sumoringer",  cost: 5, skins: 1  },
};

const HOTBAR_TYPES = ["01", "02", "03", "04", "05", "10", "11"];

const P1 = 0, P2 = 1;
const PH_KING_PLACE = "kingPlace";
const PH_SETUP      = "setup";
const PH_PLAY       = "play";
const PH_END        = "end";

const FLIP_DURATION_MS = 600;
const DRAG_THRESHOLD_PX = 5;
const PIECE_VISUAL_OFFSET_Y = -4;   // shift all rendered figures up by 4px
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
  hotbars: [[], []],
  selectedHotbarIdx: [null, null],
  selectedSquare: null,
  legalMoves: [],
  kingsPlaced: [false, false],
  setupDone:   [false, false],
  scale: 3,
  animating: false,
  flipAnim: null,
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

    // ── Blocker ("10"): Turm-Züge, kann nicht schlagen und nicht geschlagen werden
    case "10": {
      const dirs10 = [[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dr, dc] of dirs10) {
        let r = row + dr, c = col + dc;
        while (inBounds(r, c)) {
          if (board[r][c]) break;          // blockiert von jeder Figur
          push(r, c, false);               // nur leere Felder
          r += dr; c += dc;
        }
      }
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
            if (!t2)                          moves.push(sumoLand(r2, c2, dr, dc, false));
            else if (t2.color !== p.color)    moves.push(sumoLand(r2, c2, dr, dc, true));
          }
        } else if (t1.color !== p.color) {
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
const hotbarCanvas = document.getElementById("hotbar-canvas");
const hotbarCtx = hotbarCanvas.getContext("2d");

function drawAll() {
  drawBoard();
  drawHotbar();
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
      container.appendChild(img);
    }
    _capturedRendered[color] = list.length;
  }
}

function drawBoard() {
  // Always draw at logical resolution (188×196); CSS handles the display upscale.
  boardCtx.setTransform(1, 0, 0, 1, 0, 0);
  boardCtx.imageSmoothingEnabled = false; // nearest-neighbour inside the canvas
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

      const imgX = x;
      const imgY = y + PIECE_VISUAL_OFFSET_Y;
      const isHovered = doHoverZoom && hoverZoomCell
        && hoverZoomCell.row === r && hoverZoomCell.col === c
        && hoverZoomProgress > 0;
      const hasFancyTransform = doSway || isHovered;

      boardCtx.save();

      // Drop-shadow on piece (canvas is always at logical scale — no S multiplier needed)
      if (doShadows) {
        boardCtx.shadowColor   = "rgba(0, 0, 0, 0.55)";
        boardCtx.shadowBlur    = 4;
        boardCtx.shadowOffsetX = 1;
        boardCtx.shadowOffsetY = 2;
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
          const eased = 1 - (1 - hoverZoomProgress) * (1 - hoverZoomProgress);
          const zoomS  = 1.0 + (HOVER_ZOOM_TARGET - 1.0) * eased;
          const cx = imgX + CELL / 2;
          const cy = imgY + CELL / 2;
          boardCtx.translate(cx, cy);
          boardCtx.scale(zoomS, zoomS);
          boardCtx.translate(-cx, -cy);
        }
      }

      // Always nearest-neighbor — the hi-res canvas (S×) already minimises block artefacts
      boardCtx.drawImage(img, imgX, imgY);

      boardCtx.restore();
    }
  }

  // Selected square outline
  if (state.selectedSquare && state.phase === PH_PLAY) {
    const { x, y } = cellToCanvas(state.selectedSquare.row, state.selectedSquare.col);
    boardCtx.strokeStyle = "rgba(255, 240, 60, 0.6)";
    boardCtx.lineWidth = 1;
    boardCtx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
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
          boardCtx.drawImage(img, x, y + PIECE_VISUAL_OFFSET_Y);
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
    for (const m of _hoverPreviewMoves) {
      const { x, y } = cellToCanvas(m.row, m.col);
      const img = m.capture ? images["images/markerHit.png"] : images["images/marker.png"];
      if (img) boardCtx.drawImage(img, x, y);
    }
    boardCtx.restore();
  }

  // Markers ON TOP of pieces & hover preview (with colored glow drop-shadow)
  const highlights = currentHighlights();
  for (const h of highlights) {
    const { x, y } = cellToCanvas(h.row, h.col);
    const img = h.capture ? images["images/markerHit.png"] : images["images/marker.png"];
    boardCtx.save();
    if (h.capture) {
      boardCtx.shadowColor = "rgba(0, 0, 0, 0.9)";
      boardCtx.shadowBlur = 3;
      boardCtx.shadowOffsetX = 0;
      boardCtx.shadowOffsetY = 1;
      boardCtx.drawImage(img, x, y);
      boardCtx.shadowColor = "rgba(255, 50, 50, 1)";
      boardCtx.shadowBlur = 8;
      boardCtx.shadowOffsetY = 0;
      boardCtx.drawImage(img, x, y);
      boardCtx.drawImage(img, x, y);
    } else {
      boardCtx.shadowColor = "rgba(255, 230, 90, 0.9)";
      boardCtx.shadowBlur = 4;
      boardCtx.drawImage(img, x, y);
    }
    boardCtx.restore();
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
  const newCell = isOwn ? cell : null;
  const changed = (newCell === null) !== (hoverZoomCell === null)
    || (newCell && hoverZoomCell && (newCell.row !== hoverZoomCell.row || newCell.col !== hoverZoomCell.col));
  if (changed) {
    hoverZoomCell = newCell;
    hoverZoomHotbarSlot = null;
    startHoverZoomLoop();
  }
}

function _clearBoardHoverZoom() {
  if (!fancyGraphics || !fancyHoverZoom) return;
  if (hoverZoomCell !== null) {
    hoverZoomCell = null;
    startHoverZoomLoop();
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
  // Hotbar fades in/out via CSS opacity transition.
  // Online: always show YOUR OWN hotbar during the entire setup phase.
  // Local:  visible only during SETUP (current player's turn).
  const visible = (state.phase === PH_SETUP);
  hotbarCanvas.classList.toggle("visible", visible);
  // When fading out, keep the last rendered content so the fade looks smooth
  if (!visible) return;

  // High-res internal canvas → logical coords decoupled from displayed pixel grid
  hotbarCtx.setTransform(HOTBAR_INTERNAL_SCALE, 0, 0, HOTBAR_INTERNAL_SCALE, 0, 0);
  hotbarCtx.imageSmoothingEnabled = false;
  hotbarCtx.clearRect(0, 0, BOARD_W, HOTBAR_CANVAS_H);

  const o = hotbarOriginInCanvas();
  hotbarCtx.drawImage(images["images/hotbar.png"], o.x, o.y);

  if (state.phase === PH_SETUP) {
    // Online: always draw MY hotbar. Local: draw the current player's hotbar.
    const player = state.online.active ? state.online.myColor : state.current;
    const hotbar = state.hotbars[player];
    const draggingHotbarIdx = (state.pointer && state.pointer.dragging
                               && state.pointer.source === "hotbar")
                              ? state.pointer.payload.slot : -1;
    for (let i = 0; i < 4; i++) {
      const type = hotbar[i];
      const slotX = o.x + hotbarSlotX(i);
      const img = images[`images/figures/${player}${type}0.png`];
      const py = o.y + (HOTBAR_H - 23) / 2 + PIECE_VISUAL_OFFSET_Y;
      const cost = PIECE_INFO[type].cost;
      const canAfford = state.budgets[player] >= cost;
      const isSelected = state.selectedHotbarIdx[player] === i;

      let alpha = canAfford ? 1.0 : 0.45;
      if (i === draggingHotbarIdx) alpha = 0.35;

      const hotbarZooming = fancyHoverZoom && hoverZoomHotbarSlot === i && hoverZoomProgress > 0;
      if (hotbarZooming) {
        const eased = 1 - (1 - hoverZoomProgress) * (1 - hoverZoomProgress);
        const zoomS  = 1.0 + (HOVER_ZOOM_TARGET - 1.0) * eased;
        const cx = slotX + CELL / 2;
        const cy = py + CELL / 2;
        hotbarCtx.save();
        hotbarCtx.translate(cx, cy);
        hotbarCtx.scale(zoomS, zoomS);
        hotbarCtx.translate(-cx, -cy);
        drawHotbarFigure(hotbarCtx, img, slotX, py, isSelected, alpha);
        hotbarCtx.restore();
      } else {
        drawHotbarFigure(hotbarCtx, img, slotX, py, isSelected, alpha);
      }

      // cost number — handcrafted 3x5 pixel digits, bottom-right of slot
      const costColor   = canAfford ? "#ffe45c" : "#888";
      const costShadow  = "rgba(0, 0, 0, 0.7)";
      const slotRight   = slotX + HOTBAR_SLOT_W;
      const slotBottom  = o.y + (HOTBAR_H - HOTBAR_BORDER) + 0; // sits inside slot
      drawPixelNumber(hotbarCtx, cost, slotRight - 1, slotBottom - 1, costColor, costShadow);
    }
  }
}

function drawHotbarFigure(ctx, img, x, y, isSelected, alpha) {
  if (!img) return;
  // Shadow values are in INTERNAL canvas pixels (not affected by ctx.scale).
  // We multiply by HOTBAR_INTERNAL_SCALE to keep visuals consistent in logical units.
  const R = HOTBAR_INTERNAL_SCALE;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (isSelected) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2 * R;
    ctx.shadowBlur = 1 * R;
    const cx = x + CELL / 2;
    const cy = y + CELL / 2;
    const s = 1.25;     // with R=4 → 5/4 ratio → clean 5x integer source-to-internal scaling
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, -CELL / 2, -CELL / 2);
  } else {
    ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1 * R;
    ctx.shadowBlur = 0;
    ctx.drawImage(img, x, y);
  }
  ctx.restore();
}

function drawHud() {
  const phaseLabel = document.getElementById("phase-label");
  const playerLabel = document.getElementById("player-label");
  const coinValue = document.getElementById("coin-value");
  const finishBtn = document.getElementById("finish-btn");
  const messageEl = document.getElementById("message");
  const coinLabel = document.getElementById("coin-label");

  phaseLabel.textContent = ({
    [PH_KING_PLACE]: "König setzen",
    [PH_SETUP]:      "Aufstellung",
    [PH_PLAY]:       "Spiel läuft",
    [PH_END]:        "Ende",
  })[state.phase];

  playerLabel.textContent = state.current === P1 ? "P1 Orange" : "P2 Blau";
  playerLabel.className = state.current === P1 ? "p1" : "p2";

  // Online: always show MY budget. Local: show current player's budget.
  const budgetPlayer = state.online.active ? state.online.myColor : state.current;
  coinValue.textContent = state.budgets[budgetPlayer];
  // Coins are only relevant during setup
  if (coinLabel) coinLabel.style.visibility = (state.phase === PH_SETUP) ? "" : "hidden";

  if (state.phase === PH_SETUP) {
    finishBtn.classList.remove("hidden");
    finishBtn.textContent = state.setupDone[state.current] ? "Wartet…" : "Fertig";
    finishBtn.disabled = state.setupDone[state.current];
  } else {
    finishBtn.classList.add("hidden");
  }

  // ONLINE: override message when waiting for opponent's turn
  if (state.online.active && state.current !== state.online.myColor && state.phase !== PH_END) {
    messageEl.textContent = "Waiting for opponent…";
    return;
  }

  // Auto-message hints
  if (state.phase === PH_KING_PLACE && !state.message) {
    messageEl.textContent = "Klicke ein Feld in deiner Grundreihe, um den König zu setzen.";
  } else {
    messageEl.textContent = state.message;
  }
}

// ============================================================
// Scaling
// ============================================================
function applyBoardCanvasMode() {
  boardCanvas.width  = BOARD_W;
  boardCanvas.height = BOARD_H;
  boardCanvas.style.imageRendering = ""; // always let CSS pixelated rule apply
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
  if (!fancyGraphics) s = Math.floor(s); // integer steps look cleanest with pixelated CSS
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
  const overlay = document.getElementById("drag-overlay");
  if (visible && imgSrc) {
    overlay.src = imgSrc;
    const sz = state.scale * CELL;
    overlay.style.width = sz + "px";
    overlay.style.height = sz + "px";
    overlay.classList.add("visible");
  } else {
    overlay.classList.remove("visible");
    overlay.src = TRANSPARENT_PIXEL;
    // Reset tilt state
    _dragTiltVX = 0; _dragTiltLastX = null; _dragTiltLastT = null;
    overlay.style.transform = "";
  }
}

function moveDragOverlay(clientX, clientY) {
  const overlay = document.getElementById("drag-overlay");
  const sz = state.scale * CELL;
  overlay.style.left = (clientX - sz / 2) + "px";
  overlay.style.top  = (clientY - sz / 2 + PIECE_VISUAL_OFFSET_Y * state.scale) + "px";

  if (dragTilt) {
    const now = performance.now();
    if (_dragTiltLastX !== null && _dragTiltLastT !== null) {
      const dt  = Math.max((now - _dragTiltLastT) / 1000, 0.004);
      const raw = (clientX - _dragTiltLastX) / dt;
      _dragTiltVX = _dragTiltVX * 0.75 + raw * 0.25;
    }
    _dragTiltLastX = clientX;
    _dragTiltLastT = now;
    _applyDragTiltAngle(overlay);
    _startDragTiltDecay();
  }
}

function _applyDragTiltAngle(overlay) {
  // Moving right → negative angle (bottom lags left)
  const angle = Math.max(-DRAG_TILT_MAX, Math.min(DRAG_TILT_MAX, -_dragTiltVX * DRAG_TILT_SCALE));
  overlay.style.transform = `rotate(${angle.toFixed(2)}deg)`;
}

function _startDragTiltDecay() {
  if (_dragTiltDecayRAF) return;
  _dragTiltDecayRAF = requestAnimationFrame(function decay() {
    if (!dragTilt || !state.pointer || !state.pointer.dragging) {
      _dragTiltDecayRAF = null;
      return;
    }
    _dragTiltVX *= 0.88;
    const overlay = document.getElementById("drag-overlay");
    _applyDragTiltAngle(overlay);
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
  // Independent from drag: keep hover updated even when no pointer is down
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
    hoverZoomCell = null;
    startHoverZoomLoop();
  }
}

function _clearHotbarHoverZoom() {
  if (hoverZoomHotbarSlot !== null) {
    hoverZoomHotbarSlot = null;
    startHoverZoomLoop();
  }
}

function onBoardHoverLeave() {
  const needRedraw = state.hoverCell !== null || _hoverPreviewCell !== null;
  state.hoverCell = null;
  _hoverPreviewCell  = null;
  _hoverPreviewMoves = null;
  _clearBoardHoverZoom();
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
      if (state.online.active && window.Online) Online.emitKingPlace(cell.row, cell.col, 0);
      nextPlayerOrAdvance();
      return;
    }
    if (ptr.payload.kind === "piece") {
      if (state.phase !== PH_SETUP) return;
      if (state.setupDone[player]) return;
      const type = ptr.payload.type;
      if (state.budgets[player] < PIECE_INFO[type].cost) return;
      if (!canPlacePieceAt(player, cell.row, cell.col)) return;
      state.board[cell.row][cell.col] = makePiece(player, type);
      state.budgets[player] -= PIECE_INFO[type].cost;
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
    state.enPassant = move.twoSquare ? { row: (from.row + move.row) / 2, col: move.col } : null;
    applyMoveOnBoard(state.board, from, cell, {
      recordCapture: true, isEnPassant: move.isEnPassant,
      isPush: move.isPush,
      pushFromRow: move.pushFromRow, pushFromCol: move.pushFromCol,
      pushToRow:   move.pushToRow,   pushToCol:   move.pushToCol,
    });
    if (state.online.active && window.Online) Online.emitMove(from, cell);
    state.selectedSquare = null;
    state.legalMoves = [];
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
    if (!canPlacePieceAt(player, row, col)) return;
    state.board[row][col] = makePiece(player, type);
    state.budgets[player] -= PIECE_INFO[type].cost;
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
        state.enPassant = move.twoSquare ? { row: (sel.row + move.row) / 2, col: move.col } : null;
        applyMoveOnBoard(state.board, sel, { row, col }, {
          recordCapture: true, isEnPassant: move.isEnPassant,
          isPush: move.isPush,
      pushFromRow: move.pushFromRow, pushFromCol: move.pushFromCol,
      pushToRow:   move.pushToRow,   pushToCol:   move.pushToCol,
        });
        if (state.online.active && window.Online) Online.emitMove(sel, { row, col });
        state.selectedSquare = null;
        state.legalMoves = [];
        endPlayTurn();
        return;
      }
      if (piece && piece.color === state.current) {
        state.selectedSquare = { row, col };
        state.legalMoves = legalMoves(state.board, row, col);
        return;
      }
      state.selectedSquare = null;
      state.legalMoves = [];
      return;
    } else {
      if (piece && piece.color === state.current) {
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
        const loserName  = color  === P1 ? "Spieler 1 (Orange)" : "Spieler 2 (Blau)";
        const winnerName = (1-color) === P1 ? "Spieler 1 (Orange)" : "Spieler 2 (Blau)";
        showEndScreen("Sofortniederlage!", `${loserName}'s König steht sofort im Schach — ${winnerName} gewinnt!`);
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
    showEndScreen("Remis", "Nur noch die Könige — Unentschieden.");
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
        showEndScreen("Schachmatt!", iWon ? "Du gewinnst!" : `${state.online.opponentName} gewinnt!`);
      } else {
        showEndScreen("Schachmatt!", `${state.winner === P1 ? "Spieler 1 (Orange)" : "Spieler 2 (Blau)"} gewinnt!`);
      }
    } else {
      showEndScreen("Patt", "Unentschieden — kein gültiger Zug.");
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
  hoverZoomCell = null; hoverZoomHotbarSlot = null;
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

  boardCtx.setTransform(1, 0, 0, 1, 0, 0);
  boardCtx.imageSmoothingEnabled = false;
  boardCtx.clearRect(0, 0, BOARD_W, BOARD_H);
  boardCtx.drawImage(images["images/chessBoard.png"], 0, 0);

  for (const item of a.pieces) {
    const x = item.from.x + (item.to.x - item.from.x) * e;
    const y = item.from.y + (item.to.y - item.from.y) * e;
    const img = images[pieceFile(item.p)];
    if (img) boardCtx.drawImage(img, Math.round(x), Math.round(y));
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
  state.hotbars = [loadCustomHotbar(), loadCustomHotbar()];
  state.selectedHotbarIdx = [null, null];
  state.selectedSquare = null;
  state.legalMoves = [];
  state.kingsPlaced = [false, false];
  state.setupDone = [false, false];
  state.animating = false;
  state.flipAnim = null;
  state.message = "";
  state.winner = null;
  state.pointer = null;
  state.hoverCell = null;
  state.enPassant = null;
  hoverZoomProgress = 0; hoverZoomCell = null; hoverZoomHotbarSlot = null;
  _hoverPreviewCell = null; _hoverPreviewMoves = null;
  state.captured = [[], []];
  state.online = { active: false, myColor: null, opponentName: "" };
  setDragOverlay(false, "");
  document.getElementById("end-overlay").classList.add("hidden");
  document.getElementById("disconnect-overlay").classList.add("hidden");
  drawAll();
}

// ============================================================
// Hotbar Configuration (start-screen picker, persisted to localStorage)
// ============================================================
const HC_STORAGE_KEY = "tnm_hotbar_v1";
const HC_TYPES = ["01", "02", "03", "04", "05", "10", "11"];
const HC_NAMES = {
  "01": "Bauer", "02": "Bischof", "03": "Pferd",
  "04": "Turm",  "05": "Dame",   "10": "Blocker", "11": "Sumoringer",
};
const HC_DESCRIPTIONS = {
  "01": "1 vor, schlägt\ndiagonal",
  "02": "Diagonal,\nbeliebig weit",
  "03": "L-Sprung,\nüberspringt",
  "04": "Gerade,\nbeliebig weit",
  "05": "Alle Richtungen,\nbeliebig weit",
  "10": "Turm-Zug,\nunzerstörbar",
  "11": "Turm-Zug,\nschiebt Figuren",
};

function loadCustomHotbar() {
  try {
    const raw = localStorage.getItem(HC_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length === 4 && arr.every(t => HC_TYPES.includes(t))) return arr;
    }
  } catch (_) {}
  return ["01", "02", "03", "04"]; // sensible default
}

function saveCustomHotbar(arr) {
  try { localStorage.setItem(HC_STORAGE_KEY, JSON.stringify(arr)); } catch (_) {}
}

function initHotbarConfig() {
  const overlay   = document.getElementById("hotbar-config");
  const openBtn   = document.getElementById("hotbar-config-btn");
  const closeBtn  = document.getElementById("hc-close");
  const randomBtn = document.getElementById("hc-random-btn");
  const gallery   = document.getElementById("hc-gallery");
  const slotsEl   = document.getElementById("hc-slots");

  let hotbar   = loadCustomHotbar();   // working copy
  let selected = null;                 // piece type chosen in gallery

  function open() {
    hotbar   = loadCustomHotbar();
    selected = null;
    render();
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("visible")));
  }

  function close() {
    saveCustomHotbar(hotbar);
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
      img.src = `images/figures/0${type}0.png`;
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

      tile.append(img, name, cost, desc);
      tile.addEventListener("click", () => {
        selected = (selected === type) ? null : type;
        renderGallery();
        renderSlots(); // update drop-target highlights
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
      img.src = `images/figures/0${type}0.png`;
      img.alt = HC_NAMES[type];

      const cost = document.createElement("div");
      cost.className = "hc-slot-cost";
      cost.textContent = PIECE_INFO[type].cost + " ⚙";

      slot.append(num, img, cost);
      slot.addEventListener("click", () => {
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
  });

  // Close on backdrop click
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

async function main() {
  await preload();
  // Bump hotbar canvas internal resolution (logical 188x40 → 4x)
  hotbarCanvas.width = BOARD_W * HOTBAR_INTERNAL_SCALE;
  hotbarCanvas.height = HOTBAR_CANVAS_H * HOTBAR_INTERNAL_SCALE;
  boardCanvas.addEventListener("pointerdown", onPointerDown);
  hotbarCanvas.addEventListener("pointerdown", onPointerDown);
  boardCanvas.addEventListener("pointermove", onBoardHoverMove);
  boardCanvas.addEventListener("pointerleave", onBoardHoverLeave);
  hotbarCanvas.addEventListener("pointermove", onHotbarHoverMove);
  hotbarCanvas.addEventListener("pointerleave", () => _clearHotbarHoverZoom());
  document.getElementById("finish-btn").addEventListener("click", onFinishClicked);
  document.getElementById("restart-btn").addEventListener("click", resetGame);

  // Hotbar config
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
  const FANCY_FRAMES = 8;
  const FANCY_FPS    = 36;
  const fancySubGroup = document.getElementById("fancy-sub-options");

  // Generic helper: wire an On/Off toggle image to a getter/setter pair
  function makeFancyToggle(elemId, getValue, setValue) {
    const el = document.getElementById(elemId);
    let animating = false;
    el.addEventListener("click", () => {
      if (animating) return;
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
          animating = false;
        }
      }, 1000 / FANCY_FPS);
    });
  }

  // Main Fancy Graphics toggle
  makeFancyToggle("fancy-toggle",
    () => fancyGraphics,
    (v) => {
      fancyGraphics = v;
      fancySubGroup.classList.toggle("visible", v);
      updateScale();   // decimal ↔ integer zoom + canvas resize
      drawAll();
    }
  );

  // Sub-option: Schatten
  makeFancyToggle("fancy-shadows-toggle",
    () => fancyShadows,
    (v) => { fancyShadows = v; drawBoard(); }
  );

  // Sub-option: Schwanken
  makeFancyToggle("fancy-sway-toggle",
    () => fancySway,
    (v) => { fancySway = v; if (v) startSwayLoop(); else drawBoard(); }
  );

  // Sub-option: Hover Zoom
  makeFancyToggle("fancy-hover-toggle",
    () => fancyHoverZoom,
    (v) => { fancyHoverZoom = v; drawBoard(); }
  );

  // Standalone: Drag Tilt
  makeFancyToggle("drag-tilt-toggle",
    () => dragTilt,
    (v) => {
      dragTilt = v;
      if (!v) {
        // Reset immediately if dragging
        _dragTiltVX = 0; _dragTiltLastX = null; _dragTiltLastT = null;
        const ov = document.getElementById("drag-overlay");
        ov.style.transform = "";
      }
    }
  );

  // Start screen → Play button kicks off the game
  document.getElementById("play-btn").addEventListener("click", () => {
    const playBtn       = document.getElementById("play-btn");
    const playOnlineBtn = document.getElementById("play-online-btn");
    const startScreen   = document.getElementById("start-screen");
    const stageWrap     = document.getElementById("stage-wrapper");

    // 1) Fly both buttons downward together
    playBtn.classList.add("fly-down");
    playOnlineBtn.classList.add("fly-down");

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
  window.addEventListener("resize", () => { updateScale(); drawAll(); });
  // Prevent default touch behaviors over canvases
  for (const el of [boardCanvas, hotbarCanvas]) {
    el.addEventListener("touchstart", e => e.preventDefault(), { passive: false });
  }
  updateScale();
  // Don't start the game automatically — wait for the player to press Play
  // (the #start-screen overlay covers everything until then)

  // Wire up online module after everything is ready
  if (window.Online) Online.init();
}

main();
