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
  let socket            = null;
  let myName            = "";
  let myColor           = null;   // 0 | 1
  let pendingChallenger = null;   // name of person challenging us
  let challengeSent     = false;  // debounce: we sent a challenge
  let reconnectTimer    = null;
  let _leavingLobby     = false;  // true while animating back to start screen

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
    emitResign() {
      if (socket) socket.emit("game:resign");
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
      // Re-register in lobby with same name (idempotent on server)
      if (socket && myName) {
        socket.emit("lobby:join", { name: myName, wappen: _getLocalWappen(), hotbar: _getP1Hotbar() });
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
      // Fly all start-screen buttons down together
      btn.classList.add("fly-down");
      playBtn.classList.add("fly-down");
      document.getElementById("hotbar-config-btn").classList.add("fly-down");
      document.getElementById("wappen-config-btn").classList.add("fly-down");
      btn.addEventListener("animationend", () => {
        startScreen$().classList.add("hidden");
        _connectAndShowLobby();
      }, { once: true });
    });

    // Shared: hide lobby, show start screen, fly all 4 buttons back up
    function _returnToStartScreen(emitLeave) {
      _leavingLobby = true;   // block lobby:state from re-opening the lobby
      if (emitLeave && socket) socket.emit("lobby:leave");
      lobby$().classList.remove("visible");

      const startScreen = startScreen$();
      startScreen.classList.remove("hidden");
      startScreen.style.opacity       = "";  // clear inline — let CSS class control opacity
      startScreen.style.pointerEvents = "";

      // Two nested rAFs: first frame removes fly-down (committed by browser),
      // second frame adds fly-up as a fresh animation — prevents pointer-events: none
      // from getting stuck if the browser merges both classList changes into one tick.
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
    }

    // Name-entry screen: X and Back → return without emitting lobby:leave (not yet joined)
    document.getElementById("online-name-close").addEventListener("click", () => _returnToStartScreen(false));
    document.getElementById("name-back-btn").addEventListener("click",     () => _returnToStartScreen(false));

    // "Join" — submit name
    document.getElementById("name-confirm-btn").addEventListener("click", _submitName);
    nameInput$().addEventListener("keydown", e => { if (e.key === "Enter") _submitName(); });

    // Lobby room X → disconnect server-side, then fly back up
    document.getElementById("online-lobby-close").addEventListener("click", () => _returnToStartScreen(true));

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

    // Restart button override — only intercept when an online game is actually active
    restartBtn$().addEventListener("click", e => {
      if (state.online.active) {
        e.stopImmediatePropagation();
        Online.returnToLobby();
      }
    }, true /* capture — fires before game.js listener */);
  }

  // ── Connect socket & show name screen ─────────────────────
  function _connectAndShowLobby() {
    _leavingLobby = false;   // ← clear any leftover leave-guard from a previous session
    // Connect socket if not already connected
    if (!socket) {
      socket = io();
      _wireSocketEvents();
    }

    // Prepare sub-screens
    nameError$().classList.add("hidden");
    // Pre-fill name: in-session memory first, then localStorage
    const savedName = localStorage.getItem("tnm_online_name") || "";
    nameInput$().value = myName || savedName;
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
    localStorage.setItem("tnm_online_name", myName); // persist name
    nameError$().classList.add("hidden");
    if (socket) socket.emit("lobby:join", { name: myName, wappen: _getLocalWappen(), hotbar: _getP1Hotbar() });
  }

  function _getLocalWappen() {
    try {
      const raw = localStorage.getItem("tnm_wappen_v1");
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function _getP1Hotbar() {
    try {
      const raw = localStorage.getItem("tnm_hotbar_v1");
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function _showLobbyRoom() {
    _leavingLobby = false;   // we're actively in the lobby now
    nameScreen$().classList.add("hidden");
    lobbyRoom$().classList.remove("hidden");
    lobby$().classList.add("visible");
    lobbyMsg$().textContent = "";
  }

  // ── Lobby player list rendering ───────────────────────────
  // waiting: string[]  — names of players in "waiting" state (includes self)
  // playing: [string, string][]  — pairs of names currently in a game
  function _renderLobbyList(waiting, playing) {
    const list = playerList$();
    list.innerHTML = "";

    // ── Self entry (always shown if we're in the lobby)
    const selfEntry = document.createElement("div");
    selfEntry.className = "lobby-player-entry lobby-self-entry";
    const selfName = document.createElement("span");
    selfName.className = "lobby-player-name";
    selfName.textContent = myName;
    const selfBadge = document.createElement("span");
    selfBadge.className = "lobby-self-badge";
    selfBadge.textContent = "You";
    selfEntry.appendChild(selfName);
    selfEntry.appendChild(selfBadge);
    list.appendChild(selfEntry);

    // ── Other waiting players
    const others = waiting.filter(n => n !== myName);

    if (others.length === 0 && playing.length === 0) {
      const msg = document.createElement("p");
      msg.className = "lobby-empty-msg";
      msg.textContent = "No one else here yet…";
      list.appendChild(msg);
      return;
    }

    for (const name of others) {
      const entry = document.createElement("div");
      entry.className = "lobby-player-entry";

      const nameSpan = document.createElement("span");
      nameSpan.className = "lobby-player-name";
      nameSpan.textContent = name;

      const btn = document.createElement("button");
      btn.className = "lobby-challenge-btn";
      btn.textContent = "Challenge";
      if (challengeSent) btn.disabled = true;
      btn.addEventListener("click", () => {
        if (challengeSent) return;
        _sendChallenge(name);
      });

      entry.appendChild(nameSpan);
      entry.appendChild(btn);
      list.appendChild(entry);
    }

    // ── Playing pairs
    if (playing.length > 0) {
      const divider = document.createElement("p");
      divider.className = "lobby-ingame-label";
      divider.textContent = "In game:";
      list.appendChild(divider);

      for (const [p1, p2] of playing) {
        const entry = document.createElement("div");
        entry.className = "lobby-player-entry lobby-ingame-entry";

        const nameSpan = document.createElement("span");
        nameSpan.className = "lobby-player-name lobby-vs-text";
        nameSpan.textContent = `${p1} vs ${p2}`;

        entry.appendChild(nameSpan);
        list.appendChild(entry);
      }
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
  function _startOnlineGame(color, opponentName, myHotbar) {
    myColor = color;
    challengeSent = false;

    // Hide lobby, show game
    lobby$().classList.remove("visible");
    challModal$().classList.add("hidden");

    // Trigger the same play-btn animation / fade-in logic
    const stageWrap = stageWrap$();

    // Prepare game state for online
    resetGame();  // clears board, sets PH_KING_PLACE (also loads local hotbars)
    state.online.active       = true;
    state.online.myColor      = color;
    state.online.opponentName = opponentName;

    // Use the player's own P1 hotbar for their color
    if (myHotbar) state.hotbars[color] = myHotbar;

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
    if (window.Sounds) Sounds.play("place");
    // advance phase/turn same as local (server already sends phase_change / turn_change)
    drawAll();
  }

  function _applyOpponentPiecePlace(row, col, type, skin, color) {
    state.board[row][col] = { color, type, skin };
    state.budgets[color] -= PIECE_INFO[type]?.cost ?? 0;
    if (window.Sounds) Sounds.play("place");
    drawAll();
  }

  function _applyOpponentMove(fromRow, fromCol, toRow, toCol, isEnPassant, newEnPassant) {
    const from = { row: fromRow, col: fromCol };
    const to   = { row: toRow,   col: toCol   };
    applyMoveOnBoard(state.board, from, to, { recordCapture: true, isEnPassant });
    state.enPassant = newEnPassant || null;
    if (window.Sounds) Sounds.play("place");
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

    // Re-enter lobby (idempotent: server already set us to "waiting")
    _showLobbyRoom();
    if (socket && myName) {
      socket.emit("lobby:join", { name: myName, wappen: _getLocalWappen(), hotbar: _getP1Hotbar() });
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

    socket.on("lobby:state", ({ waiting, playing }) => {
      // Ignore while in-game or while we're navigating away from the lobby
      if (state.online.active || _leavingLobby) return;
      _showLobbyRoom();
      _renderLobbyList(waiting || [], playing || []);
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

    socket.on("game:start", ({ color, opponentName, myHotbar, opponentWappen }) => {
      _startOnlineGame(color, opponentName, myHotbar);
      if (window.setOnlineWappens) setOnlineWappens(color, opponentWappen);
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

    socket.on("game:moved", ({ fromRow, fromCol, toRow, toCol, isEnPassant, newEnPassant }) => {
      _applyOpponentMove(fromRow, fromCol, toRow, toCol, isEnPassant, newEnPassant);
    });

    socket.on("game:over", ({ reason, winner }) => {
      if (reason === "resign") {
        const iWon = winner === myColor;
        showEndScreen("Resignation!", iWon ? "Opponent resigned — you win!" : "You resigned.");
      } else if (reason === "forfeit") {
        showEndScreen("Victory!", "Opponent didn't reconnect — you win!");
      } else if (reason === "stalemate") {
        showEndScreen("Stalemate", "Draw — no legal moves.");
      } else if (reason === "immediateCheck") {
        const iWon = winner === myColor;
        showEndScreen("Instant Loss!", iWon ? "Opponent's King was immediately in check — you win!" : "Your King is immediately in check — you lose!");
      }
      // checkmate is handled locally by checkGameOver()
      state.phase = PH_END;
      drawAll();
    });

    socket.on("game:opponent_left", () => {
      _returnToMenu();
      lobbyMsg$().textContent = "Opponent left the game.";
    });
  }

})();
