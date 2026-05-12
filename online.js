"use strict";

// ============================================================
// online.js — client-side networking + lobby UI
// Loaded after game.js; accesses state, drawAll, etc. globally.
// ============================================================

(function () {

  // ── DOM refs ──────────────────────────────────────────────
  const lobby$      = () => document.getElementById("online-lobby");
  const nameScreen$ = () => document.getElementById("online-name-screen");
  const lobbyRoom$  = () => document.getElementById("online-lobby-room");
  const nameInput$  = () => document.getElementById("player-name-input");
  const nameError$  = () => document.getElementById("name-error");
  const playerList$ = () => document.getElementById("lobby-player-list");
  const lobbyMsg$   = () => document.getElementById("lobby-status-msg");
  const challModal$ = () => document.getElementById("challenge-modal");
  const challMsg$   = () => document.getElementById("challenge-msg");
  const discOverlay$= () => document.getElementById("disconnect-overlay");
  const discMsg$    = () => document.getElementById("disconnect-msg");
  const discSub$    = () => document.getElementById("disconnect-sub");
  const startScreen$= () => document.getElementById("start-screen");
  const stageWrap$  = () => document.getElementById("stage-wrapper");
  const endOverlay$ = () => document.getElementById("end-overlay");
  const restartBtn$ = () => document.getElementById("restart-btn");

  // ── State ─────────────────────────────────────────────────
  let socket         = null;
  let myName         = "";
  let myColor        = null;   // 0 | 1
  let pendingChallenger = null; // name of person challenging us
  let challengeSent  = false;  // debounce: we sent a challenge
  let reconnectTimer = null;

  // ── Public API (window.Online) ────────────────────────────
  const Online = {

    // Called once the game canvas is ready (from main() in game.js)
    init() {
      _wireStaticButtons();
    },

    // Expose helpers used by game.js hooks
    emitKingPlace(row, col, skin) {
      if (socket) socket.emit("game:king_place", { row, col, skin });
    },
    emitPiecePlace(row, col, type, skin) {
      if (socket) socket.emit("game:piece_place", { row, col, type, skin });
    },
    emitFinishSetup() {
      if (socket) socket.emit("game:finish_setup");
    },
    emitMove(from, to) {
      if (socket) socket.emit("game:move", {
        fromRow: from.row, fromCol: from.col,
        toRow:   to.row,   toCol:   to.col,
      });
    },

    hideLobby() {
      lobby$().classList.remove("visible");
    },

    returnToLobby() {
      // End-screen "Restart" in online mode → go back to lobby
      endOverlay$().classList.add("hidden");
      resetGame();                   // clears state.online
      stageWrap$().classList.remove("visible");
      _showLobbyRoom();
      // Re-register in lobby with same name
      if (socket && myName) {
        socket.emit("lobby:join", { name: myName });
      }
    },
  };

  window.Online = Online;

  // ── Static button wiring ──────────────────────────────────
  function _wireStaticButtons() {
    // "Play Online" on start screen — fly button down, then fade in lobby
    document.getElementById("play-online-btn").addEventListener("click", () => {
      const btn     = document.getElementById("play-online-btn");
      const playBtn = document.getElementById("play-btn");
      // Fly both buttons down together
      btn.classList.add("fly-down");
      playBtn.classList.add("fly-down");
      btn.addEventListener("animationend", () => {
        startScreen$().classList.add("hidden");
        _connectAndShowLobby();
      }, { once: true });
    });

    // "Back" from name-entry → return to start screen
    document.getElementById("name-back-btn").addEventListener("click", () => {
      lobby$().classList.remove("visible");
      startScreen$().classList.remove("hidden");
      startScreen$().style.opacity = "1";
      startScreen$().style.pointerEvents = "";
    });

    // "Join" — submit name
    document.getElementById("name-confirm-btn").addEventListener("click", _submitName);
    nameInput$().addEventListener("keydown", e => { if (e.key === "Enter") _submitName(); });

    // "Leave" from lobby room → disconnect and back to start screen
    document.getElementById("lobby-back-btn").addEventListener("click", () => {
      if (socket) socket.emit("lobby:leave");
      lobby$().classList.remove("visible");
      startScreen$().classList.remove("hidden");
      startScreen$().style.opacity = "1";
      startScreen$().style.pointerEvents = "";
    });

    // Challenge modal — Accept
    document.getElementById("challenge-accept-btn").addEventListener("click", () => {
      if (!pendingChallenger) return;
      const name = pendingChallenger;
      pendingChallenger = null;
      challModal$().classList.add("hidden");
      if (socket) socket.emit("challenge:accept", { challengerName: name });
    });

    // Challenge modal — Decline
    document.getElementById("challenge-decline-btn").addEventListener("click", () => {
      if (!pendingChallenger) return;
      const name = pendingChallenger;
      pendingChallenger = null;
      challModal$().classList.add("hidden");
      if (socket) socket.emit("challenge:decline", { challengerName: name });
    });

    // Disconnect overlay — "Return to Menu"
    document.getElementById("disconnect-return-btn").addEventListener("click", () => {
      _returnToMenu();
    });

    // Restart button override in online mode
    restartBtn$().addEventListener("click", e => {
      if (state.online.active || (socket && myName)) {
        e.stopImmediatePropagation();
        Online.returnToLobby();
      }
    }, true /* capture — fires before game.js listener */);
  }

  // ── Connect socket & show name screen ─────────────────────
  function _connectAndShowLobby() {
    // Connect socket if not already connected
    if (!socket) {
      socket = io();
      _wireSocketEvents();
    }

    // Prepare sub-screens
    nameError$().classList.add("hidden");
    nameInput$().value = myName || "";
    nameScreen$().classList.remove("hidden");
    lobbyRoom$().classList.add("hidden");

    // Fade in the lobby overlay
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        lobby$().classList.add("visible");
        setTimeout(() => nameInput$().focus(), 80);
      });
    });
  }

  function _submitName() {
    const raw  = nameInput$().value.trim().slice(0, 16);
    if (!raw) return;
    myName = raw;
    nameError$().classList.add("hidden");
    if (socket) socket.emit("lobby:join", { name: myName });
  }

  function _showLobbyRoom() {
    nameScreen$().classList.add("hidden");
    lobbyRoom$().classList.remove("hidden");
    lobby$().classList.add("visible");
    lobbyMsg$().textContent = "";
  }

  // ── Lobby player list rendering ───────────────────────────
  function _renderLobbyList(players) {
    const list = playerList$();
    list.innerHTML = "";

    // Filter out self
    const others = players.filter(p => p.name !== myName);

    if (others.length === 0) {
      const msg = document.createElement("p");
      msg.className = "lobby-empty-msg";
      msg.textContent = "No one else here yet…";
      list.appendChild(msg);
      return;
    }

    for (const player of others) {
      const entry = document.createElement("div");
      entry.className = "lobby-player-entry";

      const nameSpan = document.createElement("span");
      nameSpan.className = "lobby-player-name";
      nameSpan.textContent = player.name;

      const btn = document.createElement("button");
      btn.className = "lobby-challenge-btn";
      btn.textContent = "Challenge";
      if (challengeSent) btn.disabled = true;
      btn.addEventListener("click", () => {
        if (challengeSent) return;
        _sendChallenge(player.name);
      });

      entry.appendChild(nameSpan);
      entry.appendChild(btn);
      list.appendChild(entry);
    }
  }

  function _sendChallenge(targetName) {
    challengeSent = true;
    _setAllChallengeBtnsDisabled(true);
    lobbyMsg$().textContent = `Challenging ${targetName}…`;
    if (socket) socket.emit("challenge:send", { targetName });
  }

  function _setAllChallengeBtnsDisabled(disabled) {
    const btns = document.querySelectorAll(".lobby-challenge-btn");
    for (const b of btns) b.disabled = disabled;
  }

  // ── Start the online game ─────────────────────────────────
  function _startOnlineGame(color, opponentName, hotbarP1, hotbarP2) {
    myColor = color;
    challengeSent = false;

    // Hide lobby, show game
    lobby$().classList.remove("visible");
    challModal$().classList.add("hidden");

    // Trigger the same play-btn animation / fade-in logic
    const stageWrap = stageWrap$();

    // Prepare game state for online
    resetGame();  // clears board, sets PH_KING_PLACE
    state.online.active       = true;
    state.online.myColor      = color;
    state.online.opponentName = opponentName;

    // Set hotbars from server (both players must see same hotbars)
    state.hotbars[0] = hotbarP1;
    state.hotbars[1] = hotbarP2;

    // Fix viewFlipped to our perspective for the entire game
    state.viewFlipped = (color === 1); // P2 always sees from the bottom

    // Ensure correct scale, then fade in and draw
    updateScale();
    stageWrap.classList.add("visible");
    drawAll();
  }

  // ── Applying opponent moves to local state ────────────────
  function _applyOpponentKingPlace(row, col, skin, color) {
    state.board[row][col] = { color, type: "00", skin: skin || 0 };
    state.kingsPlaced[color] = true;
    // advance phase/turn same as local (server already sends phase_change / turn_change)
    drawAll();
  }

  function _applyOpponentPiecePlace(row, col, type, skin, color) {
    state.board[row][col] = { color, type, skin };
    state.budgets[color] -= PIECE_INFO[type]?.cost ?? 0;
    drawAll();
  }

  function _applyOpponentMove(fromRow, fromCol, toRow, toCol) {
    const from = { row: fromRow, col: fromCol };
    const to   = { row: toRow,   col: toCol   };
    applyMoveOnBoard(state.board, from, to, { recordCapture: true });
    drawAll();
  }

  // ── Disconnect / forfeit handling ─────────────────────────
  function _showDisconnectOverlay(msg, sub) {
    discMsg$().textContent  = msg || "Opponent disconnected.";
    discSub$().textContent  = sub || "";
    discOverlay$().classList.remove("hidden");
  }

  function _returnToMenu() {
    discOverlay$().classList.add("hidden");
    challModal$().classList.add("hidden");
    endOverlay$().classList.add("hidden");
    stageWrap$().classList.remove("visible");
    lobby$().classList.remove("visible");
    resetGame();

    // Re-enter lobby
    _showLobbyRoom();
    if (socket && myName) {
      socket.emit("lobby:join", { name: myName });
    }
  }

  // ── Socket event wiring ───────────────────────────────────
  function _wireSocketEvents() {

    socket.on("connect", () => {
      console.log("[Online] connected:", socket.id);
    });

    socket.on("disconnect", () => {
      console.log("[Online] socket disconnected");
    });

    // ── Lobby events ────────────────────────────────────────

    socket.on("lobby:state", ({ players }) => {
      // Ignore lobby updates while we're in an active game
      if (state.online.active) return;
      _showLobbyRoom();
      _renderLobbyList(players);
    });

    socket.on("lobby:name_taken", () => {
      nameError$().textContent = "Name already taken!";
      nameError$().classList.remove("hidden");
    });

    // ── Challenge events ─────────────────────────────────────

    socket.on("challenge:incoming", ({ challengerName }) => {
      pendingChallenger = challengerName;
      challMsg$().textContent = `${challengerName} challenges you!`;
      challModal$().classList.remove("hidden");
    });

    socket.on("challenge:cancelled", ({ challengerName }) => {
      if (pendingChallenger === challengerName) {
        pendingChallenger = null;
        challModal$().classList.add("hidden");
      }
    });

    socket.on("challenge:declined", ({ targetName }) => {
      challengeSent = false;
      _setAllChallengeBtnsDisabled(false);
      lobbyMsg$().textContent = `${targetName} declined your challenge.`;
    });

    // ── Game start ──────────────────────────────────────────

    socket.on("game:start", ({ color, opponentName, hotbarP1, hotbarP2 }) => {
      _startOnlineGame(color, opponentName, hotbarP1, hotbarP2);
    });

    // ── In-game events ───────────────────────────────────────

    socket.on("game:king_placed", ({ color, row, col, skin }) => {
      _applyOpponentKingPlace(row, col, skin, color);
    });

    socket.on("game:piece_placed", ({ color, row, col, type, skin }) => {
      _applyOpponentPiecePlace(row, col, type, skin, color);
    });

    socket.on("game:setup_finished", ({ color }) => {
      state.setupDone[color] = true;
      drawAll();
    });

    socket.on("game:turn_change", ({ current }) => {
      state.current = current;
      drawAll();
    });

    socket.on("game:phase_change", ({ phase, current }) => {
      state.phase   = phase;
      state.current = current;
      state.selectedSquare = null;
      state.legalMoves     = [];
      drawAll();
    });

    socket.on("game:moved", ({ fromRow, fromCol, toRow, toCol }) => {
      _applyOpponentMove(fromRow, fromCol, toRow, toCol);
      // turn_change will follow separately — just redraw here
    });

    socket.on("game:over", ({ reason, winner }) => {
      // Server-side checkmate/stalemate/resign/forfeit
      if (reason === "resign") {
        const iWon = winner === myColor;
        showEndScreen("Aufgabe!", iWon ? "Gegner hat aufgegeben — du gewinnst!" : "Du hast aufgegeben.");
      } else if (reason === "forfeit") {
        showEndScreen("Sieg!", "Gegner hat nicht reconnected — du gewinnst!");
      } else if (reason === "stalemate") {
        showEndScreen("Patt", "Unentschieden — kein gültiger Zug.");
      }
      // checkmate is handled locally by checkGameOver()
      state.phase = PH_END;
      drawAll();
    });

    socket.on("game:opponent_disconnected", () => {
      _showDisconnectOverlay(
        "Opponent disconnected.",
        "Waiting 60 s for reconnect…"
      );
    });

    socket.on("game:opponent_reconnected", () => {
      discOverlay$().classList.add("hidden");
    });

    socket.on("game:forfeit", () => {
      discOverlay$().classList.add("hidden");
      showEndScreen("Sieg!", "Gegner hat nicht reconnected — du gewinnst!");
      state.phase = PH_END;
      drawAll();
    });

    socket.on("game:reconnected", ({ color, opponentName, board, budgets,
                                     hotbars, phase, current, setupDone,
                                     kingsPlaced, captured }) => {
      // Full resync after returning from a disconnect
      _startOnlineGame(color, opponentName, hotbars[0], hotbars[1]);
      state.board       = board;
      state.budgets     = budgets;
      state.phase       = phase;
      state.current     = current;
      state.setupDone   = setupDone;
      state.kingsPlaced = kingsPlaced;
      state.captured    = captured;
      discOverlay$().classList.add("hidden");
      drawAll();
    });
  }

})();
