"use strict";

const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const path     = require("path");
const crypto   = require("crypto");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

// Serve the game files as static assets
app.use(express.static(path.join(__dirname)));

// ============================================================
// Pure game-logic (duplicated from game.js — no DOM needed)
// ============================================================
const P1 = 0, P2 = 1;
const PH_KING_PLACE = "kingPlace";
const PH_SETUP      = "setup";
const PH_PLAY       = "play";
const PH_END        = "end";

const PIECE_INFO = {
  "00": { cost: 0, skins: 1  },
  "01": { cost: 1, skins: 10 },
  "02": { cost: 3, skins: 5  },
  "03": { cost: 3, skins: 2  },
  "04": { cost: 5, skins: 1  },
  "05": { cost: 9, skins: 6  },
  "06": { cost: 1, skins: 10 },
};
const HOTBAR_TYPES = ["01", "02", "03", "04", "05"];
const BUDGET = 20;

function createEmptyBoard() {
  const b = [];
  for (let r = 0; r < 8; r++) b.push(new Array(8).fill(null));
  return b;
}

function cloneBoard(board) {
  return board.map(row => row.map(p => p ? { ...p } : null));
}

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function pawnDir(color) { return color === P1 ? +1 : -1; }
function grundReihe(player) { return player === P1 ? 0 : 7; }
function ownHalfRows(player) { return player === P1 ? [0, 1] : [6, 7]; }

function generateHotbar() {
  const arr = [...HOTBAR_TYPES];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 4);
}

function slide(board, row, col, p, dirs, push) {
  for (const [dr, dc] of dirs) {
    let r = row + dr, c = col + dc;
    while (inBounds(r, c)) {
      const t = board[r][c];
      if (!t) push(r, c, false);
      else { if (t.color !== p.color) push(r, c, true); break; }
      r += dr; c += dc;
    }
  }
}

function pseudoMoves(board, row, col) {
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
        if (!t) push(nr, nc, false);
        else if (t.color !== p.color) push(nr, nc, true);
      }
      break;
    }
    case "01": {
      const dir = pawnDir(p.color);
      const fr = row + dir;
      if (inBounds(fr, col) && !board[fr][col]) push(fr, col, false);
      for (const dc of [-1, 1]) {
        const nc = col + dc;
        if (!inBounds(fr, nc)) continue;
        const t = board[fr][nc];
        if (t && t.color !== p.color) push(fr, nc, true);
      }
      break;
    }
    case "06": {
      const dir = pawnDir(p.color);
      const fr1 = row + dir, fr2 = row + 2 * dir;
      if (inBounds(fr1, col) && !board[fr1][col]) push(fr1, col, false);
      if (inBounds(fr1, col) && inBounds(fr2, col)
          && !board[fr1][col] && board[fr2][col] && board[fr2][col].color !== p.color) {
        push(fr2, col, true);
      }
      for (const dc of [-1, 1]) {
        const nc = col + dc;
        if (!inBounds(fr1, nc)) continue;
        const t = board[fr1][nc];
        if (t && t.color !== p.color) push(fr1, nc, true);
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
  }
  return moves;
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

function applyMoveServer(board, from, to) {
  const piece  = board[from.row][from.col];
  const target = board[to.row][to.col];
  let movedPiece = { ...piece };
  if (piece.type === "01" && target && target.type === "01") {
    movedPiece.type = "06";
    if (movedPiece.skin >= PIECE_INFO["06"].skins)
      movedPiece.skin = movedPiece.skin % PIECE_INFO["06"].skins;
  }
  board[to.row][to.col] = movedPiece;
  board[from.row][from.col] = null;
  return target;
}

function legalMovesServer(board, row, col) {
  const p = board[row][col];
  if (!p) return [];
  const pseudo = pseudoMoves(board, row, col);
  const result = [];
  for (const m of pseudo) {
    const sim = cloneBoard(board);
    applyMoveServer(sim, { row, col }, { row: m.row, col: m.col });
    if (!isInCheck(sim, p.color)) result.push(m);
  }
  return result;
}

function hasAnyLegalMove(board, color) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board[r][c];
    if (!p || p.color !== color) continue;
    if (legalMovesServer(board, r, c).length > 0) return true;
  }
  return false;
}

function canAffordAnyServer(hotbar, budget) {
  for (const t of hotbar) {
    if (PIECE_INFO[t] && PIECE_INFO[t].cost <= budget) return true;
  }
  return false;
}

// ============================================================
// In-memory lobby & game state
// ============================================================
// lobby: socketId → { name, status: 'waiting'|'in-game', pendingChallengeTo, pendingChallengeFrom }
const lobby = new Map();

// games: gameId → GameRecord
const games = new Map();

// socketToGame: socketId → gameId  (quick reverse lookup)
const socketToGame = new Map();

// Reconnect windows: name → { gameId, color, timer }
const reconnectWindows = new Map();

function broadcastLobby() {
  const players = [];
  for (const [, info] of lobby) {
    if (info.status === "waiting") players.push({ name: info.name });
  }
  io.emit("lobby:state", { players });
}

function findSocketByName(name) {
  for (const [id, info] of lobby) {
    if (info.name === name) return id;
  }
  return null;
}

function createGame(p1SocketId, p2SocketId, p1Name, p2Name) {
  const gameId   = crypto.randomUUID();
  const hotbarP1 = generateHotbar();
  const hotbarP2 = generateHotbar();

  const g = {
    id: gameId,
    players:     [p1SocketId, p2SocketId],
    names:       [p1Name, p2Name],
    board:       createEmptyBoard(),
    phase:       PH_KING_PLACE,
    current:     P1,
    budgets:     [BUDGET, BUDGET],
    hotbars:     [hotbarP1, hotbarP2],
    kingsPlaced: [false, false],
    setupDone:   [false, false],
    captured:    [[], []],
    winner:      null,
  };
  games.set(gameId, g);
  socketToGame.set(p1SocketId, gameId);
  socketToGame.set(p2SocketId, gameId);
  return g;
}

function getGameForSocket(socketId) {
  const gid = socketToGame.get(socketId);
  return gid ? games.get(gid) : null;
}

function colorForSocket(g, socketId) {
  if (g.players[P1] === socketId) return P1;
  if (g.players[P2] === socketId) return P2;
  return null;
}

function cleanupGame(gameId) {
  const g = games.get(gameId);
  if (!g) return;
  for (const sid of g.players) socketToGame.delete(sid);
  games.delete(gameId);
}

function checkGameOverServer(g) {
  if (!hasAnyLegalMove(g.board, g.current)) {
    const inCheck = isInCheck(g.board, g.current);
    g.phase  = PH_END;
    g.winner = inCheck ? 1 - g.current : null; // null = stalemate
    return true;
  }
  return false;
}

// ============================================================
// Socket.io event handling
// ============================================================
io.on("connection", socket => {
  console.log(`[+] ${socket.id} connected`);

  // ── LOBBY JOIN ──────────────────────────────────────────────
  socket.on("lobby:join", ({ name }) => {
    if (!name || typeof name !== "string") return;
    name = name.trim().slice(0, 16);
    if (!name) return;

    // Check name uniqueness
    for (const [, info] of lobby) {
      if (info.name === name) {
        socket.emit("lobby:name_taken");
        return;
      }
    }

    // Check if returning from a reconnect window
    if (reconnectWindows.has(name)) {
      const rw = reconnectWindows.get(name);
      clearTimeout(rw.timer);
      reconnectWindows.delete(name);
      const g = games.get(rw.gameId);
      if (g) {
        // Re-register socket in game
        g.players[rw.color] = socket.id;
        socketToGame.set(socket.id, rw.gameId);
        lobby.set(socket.id, { name, status: "in-game" });

        const opp = io.sockets.sockets.get(g.players[1 - rw.color]);
        if (opp) opp.emit("game:opponent_reconnected");

        socket.emit("game:reconnected", {
          color:       rw.color,
          opponentName: g.names[1 - rw.color],
          board:       g.board,
          budgets:     g.budgets,
          hotbars:     g.hotbars,
          phase:       g.phase,
          current:     g.current,
          setupDone:   g.setupDone,
          kingsPlaced: g.kingsPlaced,
          captured:    g.captured,
        });
        return;
      }
    }

    lobby.set(socket.id, {
      name,
      status: "waiting",
      pendingChallengeTo:   null,
      pendingChallengeFrom: null,
    });
    console.log(`  lobby:join "${name}"`);
    broadcastLobby();
  });

  // ── LOBBY LEAVE ─────────────────────────────────────────────
  socket.on("lobby:leave", () => {
    lobby.delete(socket.id);
    broadcastLobby();
  });

  // ── CHALLENGE SEND ──────────────────────────────────────────
  socket.on("challenge:send", ({ targetName }) => {
    const me = lobby.get(socket.id);
    if (!me || me.status !== "waiting") return;

    const targetId = findSocketByName(targetName);
    if (!targetId) return;
    const target = lobby.get(targetId);
    if (!target || target.status !== "waiting") {
      socket.emit("challenge:declined", { targetName });
      return;
    }
    // Reject if target already has a pending incoming challenge
    if (target.pendingChallengeFrom) {
      socket.emit("challenge:declined", { targetName });
      return;
    }

    me.pendingChallengeTo = targetId;
    target.pendingChallengeFrom = socket.id;
    console.log(`  challenge: "${me.name}" → "${targetName}"`);
    io.to(targetId).emit("challenge:incoming", { challengerName: me.name });
  });

  // ── CHALLENGE ACCEPT ────────────────────────────────────────
  socket.on("challenge:accept", ({ challengerName }) => {
    const me = lobby.get(socket.id);
    if (!me) return;
    const challengerId = findSocketByName(challengerName);
    if (!challengerId) return;
    const challenger = lobby.get(challengerId);
    if (!challenger) return;

    // Challenger = P1 (orange), acceptor = P2 (cyan)
    const g = createGame(challengerId, socket.id, challenger.name, me.name);

    // Mark both as in-game
    challenger.status = "in-game";
    me.status         = "in-game";
    challenger.pendingChallengeTo   = null;
    me.pendingChallengeFrom         = null;

    console.log(`  game:start "${challenger.name}" vs "${me.name}" [${g.id}]`);

    io.to(challengerId).emit("game:start", {
      color: P1, opponentName: me.name,
      hotbarP1: g.hotbars[P1], hotbarP2: g.hotbars[P2],
    });
    socket.emit("game:start", {
      color: P2, opponentName: challenger.name,
      hotbarP1: g.hotbars[P1], hotbarP2: g.hotbars[P2],
    });

    broadcastLobby();
  });

  // ── CHALLENGE DECLINE ───────────────────────────────────────
  socket.on("challenge:decline", ({ challengerName }) => {
    const challengerId = findSocketByName(challengerName);
    if (!challengerId) return;
    const challenger = lobby.get(challengerId);
    const me = lobby.get(socket.id);

    if (challenger) challenger.pendingChallengeTo = null;
    if (me) me.pendingChallengeFrom = null;

    io.to(challengerId).emit("challenge:declined", { targetName: me ? me.name : "?" });
  });

  // ── GAME: KING PLACE ────────────────────────────────────────
  socket.on("game:king_place", ({ row, col, skin }) => {
    const g = getGameForSocket(socket.id);
    if (!g || g.phase !== PH_KING_PLACE) return;
    const color = colorForSocket(g, socket.id);
    if (color !== g.current) return;
    if (g.kingsPlaced[color]) return;
    if (row !== grundReihe(color)) return;
    if (g.board[row][col] !== null) return;

    g.board[row][col] = { color, type: "00", skin: skin || 0 };
    g.kingsPlaced[color] = true;

    const oppId = g.players[1 - color];
    io.to(oppId).emit("game:king_placed", { color, row, col, skin: skin || 0 });

    // Advance turn
    if (g.kingsPlaced[P1] && g.kingsPlaced[P2]) {
      g.phase   = PH_SETUP;
      g.current = P1;
      // notify both
      io.to(g.players[P1]).emit("game:phase_change", { phase: PH_SETUP, current: P1 });
      io.to(g.players[P2]).emit("game:phase_change", { phase: PH_SETUP, current: P1 });
    } else {
      g.current = 1 - color;
      io.to(g.players[P1]).emit("game:turn_change", { current: g.current });
      io.to(g.players[P2]).emit("game:turn_change", { current: g.current });
    }
  });

  // ── GAME: PIECE PLACE ───────────────────────────────────────
  socket.on("game:piece_place", ({ row, col, type, skin }) => {
    const g = getGameForSocket(socket.id);
    if (!g || g.phase !== PH_SETUP) return;
    const color = colorForSocket(g, socket.id);
    if (color !== g.current) return;
    if (g.setupDone[color]) return;
    if (!PIECE_INFO[type] || type === "00") return;
    if (g.budgets[color] < PIECE_INFO[type].cost) return;

    const rows = ownHalfRows(color);
    if (!rows.includes(row)) return;
    if (g.board[row][col] !== null) return;

    const clampedSkin = (skin || 0) % PIECE_INFO[type].skins;
    g.board[row][col]  = { color, type, skin: clampedSkin };
    g.budgets[color]  -= PIECE_INFO[type].cost;

    const oppId = g.players[1 - color];
    io.to(oppId).emit("game:piece_placed", { color, row, col, type, skin: clampedSkin });

    // Check if this player is now broke → auto-done
    if (!canAffordAnyServer(g.hotbars[color], g.budgets[color])) {
      g.setupDone[color] = true;
      io.to(g.players[P1]).emit("game:setup_finished", { color });
      io.to(g.players[P2]).emit("game:setup_finished", { color });
    }

    _advanceSetupTurn(g);
  });

  // ── GAME: FINISH SETUP ──────────────────────────────────────
  socket.on("game:finish_setup", () => {
    const g = getGameForSocket(socket.id);
    if (!g || g.phase !== PH_SETUP) return;
    const color = colorForSocket(g, socket.id);
    if (g.setupDone[color]) return;

    g.setupDone[color] = true;
    io.to(g.players[P1]).emit("game:setup_finished", { color });
    io.to(g.players[P2]).emit("game:setup_finished", { color });

    _advanceSetupTurn(g);
  });

  // ── GAME: MOVE ──────────────────────────────────────────────
  socket.on("game:move", ({ fromRow, fromCol, toRow, toCol }) => {
    const g = getGameForSocket(socket.id);
    if (!g || g.phase !== PH_PLAY) return;
    const color = colorForSocket(g, socket.id);
    if (color !== g.current) return;

    const from = { row: fromRow, col: fromCol };
    const to   = { row: toRow,   col: toCol   };
    const piece = g.board[fromRow]?.[fromCol];
    if (!piece || piece.color !== color) return;

    // Server-side legality check
    const legal = legalMovesServer(g.board, fromRow, fromCol);
    const isLegal = legal.some(m => m.row === toRow && m.col === toCol);
    if (!isLegal) {
      console.warn(`  illegal move attempted by "${g.names[color]}"`);
      return;
    }

    const captured = applyMoveServer(g.board, from, to);
    if (captured) g.captured[captured.color].push({ ...captured });

    g.current = 1 - color;

    const oppId = g.players[1 - color];
    io.to(oppId).emit("game:moved", { fromRow, fromCol, toRow, toCol });

    // Check game over
    if (checkGameOverServer(g)) {
      const overPayload = g.winner !== null
        ? { reason: "checkmate", winner: g.winner }
        : { reason: "stalemate", winner: null };
      io.to(g.players[P1]).emit("game:over", overPayload);
      io.to(g.players[P2]).emit("game:over", overPayload);
      cleanupGame(g.id);
    } else {
      io.to(g.players[P1]).emit("game:turn_change", { current: g.current });
      io.to(g.players[P2]).emit("game:turn_change", { current: g.current });
    }
  });

  // ── GAME: RESIGN ────────────────────────────────────────────
  socket.on("game:resign", () => {
    const g = getGameForSocket(socket.id);
    if (!g) return;
    const color = colorForSocket(g, socket.id);
    io.to(g.players[P1]).emit("game:over", { reason: "resign", winner: 1 - color });
    io.to(g.players[P2]).emit("game:over", { reason: "resign", winner: 1 - color });
    cleanupGame(g.id);
  });

  // ── DISCONNECT ──────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[-] ${socket.id} disconnected`);
    const info = lobby.get(socket.id);

    // Cancel any pending challenge this player sent
    if (info && info.pendingChallengeTo) {
      const target = lobby.get(info.pendingChallengeTo);
      if (target) {
        target.pendingChallengeFrom = null;
        io.to(info.pendingChallengeTo).emit("challenge:cancelled", { challengerName: info.name });
      }
    }
    // Cancel any pending challenge aimed at this player
    if (info && info.pendingChallengeFrom) {
      const challenger = lobby.get(info.pendingChallengeFrom);
      if (challenger) challenger.pendingChallengeTo = null;
    }

    // Mid-game disconnect
    const g = getGameForSocket(socket.id);
    if (g && g.phase !== PH_END) {
      const color = colorForSocket(g, socket.id);
      const oppId = g.players[1 - color];
      io.to(oppId).emit("game:opponent_disconnected");

      // 60-second reconnect window
      const name = info ? info.name : null;
      if (name) {
        const timer = setTimeout(() => {
          reconnectWindows.delete(name);
          const stillOngoing = games.has(g.id);
          if (stillOngoing) {
            io.to(oppId).emit("game:forfeit");
            cleanupGame(g.id);
          }
        }, 60_000);
        reconnectWindows.set(name, { gameId: g.id, color, timer });
        // Keep game in map — don't clean up yet
        socketToGame.delete(socket.id);
      } else {
        cleanupGame(g.id);
      }
    } else if (g) {
      cleanupGame(g.id);
    }

    lobby.delete(socket.id);
    broadcastLobby();
  });
});

// ── Shared setup-turn logic ──────────────────────────────────
function _advanceSetupTurn(g) {
  if (g.setupDone[P1] && g.setupDone[P2]) {
    g.phase   = PH_PLAY;
    g.current = P1;
    io.to(g.players[P1]).emit("game:phase_change", { phase: PH_PLAY, current: P1 });
    io.to(g.players[P2]).emit("game:phase_change", { phase: PH_PLAY, current: P1 });
    return;
  }
  // Alternate turns, skipping players who are done
  const next = 1 - g.current;
  if (g.setupDone[g.current] && !g.setupDone[next]) {
    g.current = next;
  } else if (!g.setupDone[next]) {
    g.current = next;
  }
  // else: next is done too but we haven't triggered startPlay — shouldn't happen
  io.to(g.players[P1]).emit("game:turn_change", { current: g.current });
  io.to(g.players[P2]).emit("game:turn_change", { current: g.current });
}

// ============================================================
// Start
// ============================================================
server.listen(PORT, () => {
  console.log(`TheNextMove server running at http://localhost:${PORT}`);
});
