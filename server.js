// server.js
// Multiplayer 5-letter “team Wordle”, 4 guesses, shared link/lobbies.
// Run: node server.js

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ----- util: small lobby/code generator (no nanoid needed) -----
function makeCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[(Math.random() * chars.length) | 0];
  return s;
}

// ----- word lists (NYT/Wordle) -----
// place these files as described below; we fallback to a tiny demo list if missing
const WORDS_ALLOWED_PATH = path.join(__dirname, "public", "words_allowed.txt");
const WORDS_ANSWERS_PATH = path.join(__dirname, "public", "words_answers.txt");

function loadWordList(p) {
  try {
    const txt = fs.readFileSync(p, "utf8");
    return txt
      .split(/\r?\n/)
      .map((w) => w.trim().toUpperCase())
      .filter((w) => /^[A-Z]{5}$/.test(w));
  } catch {
    return null;
  }
}

let ALLOWED_LIST = loadWordList(WORDS_ALLOWED_PATH);
let ANSWER_LIST = loadWordList(WORDS_ANSWERS_PATH);

// fallback (dev/demo only)
if (!ALLOWED_LIST || !ANSWER_LIST) {
  console.warn(
    "[wordlist] Missing NYT word lists. Using a tiny fallback set. " +
      "See README in this file for how to fetch the full lists."
  );
  const fallback = [
    "CRANE","SLATE","SMILE","MINTY","NASAL","APPLE","BREAD","CHAIR",
    "DANCE","EARTH","TIGER","RIVER","STONE","WATER"
  ];
  ALLOWED_LIST = fallback.slice();
  ANSWER_LIST = fallback.slice();
}

const ALLOWED = new Set(ALLOWED_LIST);

// ----- game state -----
/*
Lobby:
{
  id, answer, round (0..3), maxRounds:4,
  players: Map(slotIndex -> ws),
  slots: [ {locked, letter, byClientId} x5 ],
  history: [ { guess, colors:[] } ],
  inProgress: boolean
}
*/

const lobbies = new Map();

function freshSlots() {
  return Array.from({ length: 5 }, () => ({ locked: false, letter: "", byClientId: null }));
}
function pickAnswer() {
  return ANSWER_LIST[(Math.random() * ANSWER_LIST.length) | 0];
}
function scoreGuess(guess, answer) {
  const res = Array(5).fill("absent");
  const a = answer.split("");
  const g = guess.split("");

  const remaining = {};
  for (let i = 0; i < 5; i++) {
    if (g[i] === a[i]) res[i] = "correct";
    else remaining[a[i]] = (remaining[a[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] === "correct") continue;
    const L = g[i];
    if (remaining[L] > 0) {
      res[i] = "present";
      remaining[L]--;
    }
  }
  return res;
}
function createLobby() {
  const id = makeCode();
  const lobby = {
    id,
    answer: pickAnswer(),
    round: 0,
    maxRounds: 4,          // ← 4 total guesses
    players: new Map(),
    slots: freshSlots(),
    history: [],
    inProgress: true,
    createdAt: Date.now(),
  };
  lobbies.set(id, lobby);
  return lobby;
}
function getShareUrl(req, id) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/?lobby=${id}`;
}

// static client
app.use(express.static("public"));

// create/join endpoints
app.get("/create", (req, res) => {
  const lobby = createLobby();
  res.json({ lobbyId: lobby.id, joinUrl: getShareUrl(req, lobby.id) });
});
app.get("/health", (_, res) => res.json({ ok: true }));

// ---- websockets ----
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const lobbyId = url.searchParams.get("lobby");
  const name = (url.searchParams.get("name") || "Player").slice(0, 16);

  if (!lobbyId || !lobbies.has(lobbyId)) {
    ws.send(JSON.stringify({ type: "error", message: "Lobby not found. Use Refresh Room Code to start one." }));
    ws.close();
    return;
  }
  const lobby = lobbies.get(lobbyId);

  // assign a free slot 0..4
  let assigned = null;
  for (let i = 0; i < 5; i++) if (!lobby.players.has(i)) { assigned = i; break; }
  if (assigned === null) {
    ws.send(JSON.stringify({ type: "error", message: "Lobby full (5/5)." }));
    ws.close();
    return;
  }

  const clientId = makeCode(8);
  ws.meta = { lobbyId, slot: assigned, clientId, name };
  lobby.players.set(assigned, ws);

  // welcome
  ws.send(JSON.stringify({
    type: "join",
    lobbyId,
    slot: assigned,
    name,
    maxRounds: lobby.maxRounds,
    round: lobby.round,
    history: lobby.history,
    slots: lobby.slots,
  }));
  broadcast(lobby, { type: "roster", players: rosterView(lobby) });

  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }
    if (msg.type === "submitLetter") submitLetter(ws, lobby, msg.letter);
    if (msg.type === "unlockMySlot") unlockMySlot(ws, lobby);         // optional: let player edit before all are locked
    if (msg.type === "requestReset") if (!lobby.inProgress) resetLobby(lobby);
  });

  ws.on("close", () => {
    if (!lobbies.has(lobbyId)) return;
    const l = lobbies.get(lobbyId);
    if (l.players.get(assigned) === ws) {
      l.players.delete(assigned);
      if (!l.slots[assigned]?.locked) l.slots[assigned] = { locked: false, letter: "", byClientId: null };
      broadcast(l, { type: "roster", players: rosterView(l) });
    }
    if (l.players.size === 0 && l.history.length === 0) lobbies.delete(lobbyId);
  });
});

function submitLetter(ws, lobby, letterRaw) {
  if (!lobby.inProgress) {
    ws.send(JSON.stringify({ type: "error", message: "Game over. Start a new round." }));
    return;
  }
  const { slot, clientId } = ws.meta;
  const letter = String(letterRaw || "").trim().toUpperCase();

  if (!/^[A-Z]$/.test(letter)) {
    ws.send(JSON.stringify({ type: "error", message: "Enter one A–Z letter." }));
    return;
  }
  const slotState = lobby.slots[slot];
  if (slotState.locked) return; // already locked this round

  lobby.slots[slot] = { locked: true, letter, byClientId: clientId };
  broadcast(lobby, { type: "slotUpdate", slot, slotState: lobby.slots[slot] });

  // check if all 5 letters locked -> evaluate
  const allLocked = lobby.slots.every(s => s.locked && s.letter);
  if (!allLocked) return;

  const guess = lobby.slots.map(s => s.letter).join("");
  if (!ALLOWED.has(guess)) {
    // invalid word: DO NOT consume a row; keep letters visible; unlock for edits
    broadcast(lobby, { type: "invalidGuess", guess });
    lobby.slots = lobby.slots.map(s => ({ ...s, locked: false })); // keep letters but allow relock
    broadcast(lobby, { type: "rowUnlocked", slots: lobby.slots });
    return;
  }

  // valid: score and persist this row in history (guesses remain on screen)
  const colors = scoreGuess(guess, lobby.answer);
  const correct = guess === lobby.answer;
  lobby.history.push({ guess, colors });
  broadcast(lobby, { type: "reveal", guess, colors, correct, round: lobby.round });

  if (correct) {
    lobby.inProgress = false;
    broadcast(lobby, { type: "gameOver", reason: "solved", answer: lobby.answer });
    return;
  }

  lobby.round++;
  if (lobby.round >= lobby.maxRounds) {
    lobby.inProgress = false;
    broadcast(lobby, { type: "gameOver", reason: "out_of_rounds", answer: lobby.answer });
    return;
  }

  // next row
  lobby.slots = freshSlots();
  broadcast(lobby, { type: "newRow", round: lobby.round, slots: lobby.slots });
}

function unlockMySlot(ws, lobby) {
  const { slot } = ws.meta;
  if (!lobby.inProgress) return;
  lobby.slots[slot] = { locked: false, letter: "", byClientId: null };
  broadcast(lobby, { type: "slotUpdate", slot, slotState: lobby.slots[slot] });
}

function resetLobby(lobby) {
  lobby.answer = pickAnswer();
  lobby.round = 0;
  lobby.inProgress = true;
  lobby.history = [];
  lobby.slots = freshSlots();
  broadcast(lobby, { type: "reset", round: 0, slots: lobby.slots });
}

function rosterView(lobby) {
  return Array.from({ length: 5 }, (_, i) => {
    const ws = lobby.players.get(i);
    return { slot: i, occupied: !!ws, name: ws?.meta?.name || null };
  });
}
function broadcast(lobby, payload) {
  lobby.players.forEach((client) => {
    if (client.readyState === 1) client.send(JSON.stringify(payload));
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Game server running on http://localhost:${PORT}`);
});

/*
HOW TO GET THE FULL WORD LISTS (NYT Wordle):

1) Allowed guesses (large list):
   curl -L https://raw.githubusercontent.com/tabatkins/wordle-list/main/words -o public/words_allowed.txt

2) Official answer list (NYT-curated):
   curl -L https://raw.githubusercontent.com/LaurentLessard/wordlesolver/master/solutions_nyt.txt -o public/words_answers.txt

Both will be filtered to 5-letter uppercase on startup.
Sources: tabatkins/wordle-list, LaurentLessard/wordlesolver.
*/
