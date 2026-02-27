const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

let rooms = {};

const CANVAS_W = 1400;
const CANVAS_H = 900;
const BASE_SPEED = 2.5;
const SPEED_INCREMENT = 0.5;
const SPEED_INTERVAL = 10;
const MAX_SPEED = 8;
const TURN_SPEED = 0.045;
const TRAIL_MAX = 600;
const COLLISION_RADIUS = 4;
const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;
const COLLISION_SKIP_OWN = 20;
const LIVES = 6;

// Broadcast at ~15fps (every 4th physics tick at 60fps)
const BROADCAST_EVERY = 4;
let tickCounter = 0;

// Spawn positions for up to 8 players
const spawnConfigs = [
  { x: 250, y: 200, angle: Math.PI * 0.25 },
  { x: 1150, y: 200, angle: Math.PI * 0.75 },
  { x: 1150, y: 700, angle: Math.PI * 1.25 },
  { x: 250, y: 700, angle: Math.PI * 1.75 },
  { x: 700, y: 100, angle: Math.PI * 0.5 },
  { x: 700, y: 800, angle: Math.PI * 1.5 },
  { x: 100, y: 450, angle: 0 },
  { x: 1300, y: 450, angle: Math.PI },
];

const COLORS = ["#ff8c00", "#00bfff", "#ff2e63", "#39ff14", "#e040fb", "#ffeb3b", "#00e5ff", "#ff6e40"];

// ── ROOM CODE ──
function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms[code]);
  return code;
}

// ── CREATE PLAYER ──
// Trail stored as flat Float32Arrays for zero-GC pressure
function createPlayer(id, index, name) {
  return {
    id,
    name: typeof name === "string" && name.trim().length > 0 ? name.trim() : "Player",
    x: CANVAS_W / 2,
    y: CANVAS_H / 2,
    angle: 0,
    turning: 0,
    // Flat arrays: trailX[i], trailY[i] = position of point i
    trailX: new Float32Array(TRAIL_MAX),
    trailY: new Float32Array(TRAIL_MAX),
    trailLen: 0,       // how many points currently stored
    trailStart: 0,     // circular buffer start index
    trailSentCount: 0, // how many points have been sent to clients
    alive: true,
    score: 0,
    lives: LIVES,
    color: COLORS[index % COLORS.length],
    spawnIndex: index,
  };
}

// ── CALCULATE CURRENT SPEED ──
function getRoomSpeed(room) {
  if (!room.roundStartTime) return BASE_SPEED;
  const elapsed = (Date.now() - room.roundStartTime) / 1000;
  const boosts = Math.floor(elapsed / SPEED_INTERVAL);
  return Math.min(BASE_SPEED + boosts * SPEED_INCREMENT, MAX_SPEED);
}

// ── Trail helpers (circular buffer) ──
function trailPush(p, x, y) {
  if (p.trailLen < TRAIL_MAX) {
    const idx = (p.trailStart + p.trailLen) % TRAIL_MAX;
    p.trailX[idx] = x;
    p.trailY[idx] = y;
    p.trailLen++;
  } else {
    // Overwrite oldest point (circular)
    p.trailX[p.trailStart] = x;
    p.trailY[p.trailStart] = y;
    p.trailStart = (p.trailStart + 1) % TRAIL_MAX;
    // trailSentCount shrinks since we lost one old point
    if (p.trailSentCount > 0) p.trailSentCount--;
  }
}

function trailGetIndex(p, i) {
  // Get the i-th point (0 = oldest, trailLen-1 = newest)
  const idx = (p.trailStart + i) % TRAIL_MAX;
  return idx;
}

// ── MOVE PLAYER ──
function movePlayer(p, speed) {
  p.angle += p.turning * TURN_SPEED;
  p.x += Math.cos(p.angle) * speed;
  p.y += Math.sin(p.angle) * speed;

  trailPush(p, p.x, p.y);

  if (p.x < 0 || p.x > CANVAS_W || p.y < 0 || p.y > CANVAS_H) {
    p.alive = false;
  }
}

// ── COLLISION CHECK (optimized with bounding box pre-check) ──
function checkCollisions(players) {
  const playerIds = Object.keys(players);
  const aliveList = [];
  for (let k = 0; k < playerIds.length; k++) {
    const p = players[playerIds[k]];
    if (p.alive) aliveList.push(p);
  }

  // Pre-compute bounding boxes for all alive players' trails
  const trailBounds = {};
  for (let k = 0; k < playerIds.length; k++) {
    const other = players[playerIds[k]];
    if (!other.alive) continue; // Skip dead players entirely

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const len = other.trailLen;
    for (let i = 0; i < len; i++) {
      const idx = (other.trailStart + i) % TRAIL_MAX;
      const tx = other.trailX[idx];
      const ty = other.trailY[idx];
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
    }
    // Add collision radius padding
    trailBounds[other.id] = {
      minX: minX - COLLISION_RADIUS,
      maxX: maxX + COLLISION_RADIUS,
      minY: minY - COLLISION_RADIUS,
      maxY: maxY + COLLISION_RADIUS,
    };
  }

  for (let a = 0; a < aliveList.length; a++) {
    const p = aliveList[a];
    const px = p.x;
    const py = p.y;
    let hit = false;

    for (let k = 0; k < playerIds.length && !hit; k++) {
      const other = players[playerIds[k]];
      const isSelf = other.id === p.id;

      // Skip dead players entirely
      if (!other.alive) continue;

      const bounds = trailBounds[other.id];
      // Bounding box pre-check: skip if player is too far from this trail
      if (px < bounds.minX || px > bounds.maxX || py < bounds.minY || py > bounds.maxY) {
        continue;
      }

      const len = other.trailLen;
      const end = isSelf ? len - COLLISION_SKIP_OWN : len - 2;

      for (let i = 0; i < end; i++) {
        const idx = (other.trailStart + i) % TRAIL_MAX;
        const dx = px - other.trailX[idx];
        const dy = py - other.trailY[idx];
        // Quick reject before expensive multiplication
        if (Math.abs(dx) > COLLISION_RADIUS || Math.abs(dy) > COLLISION_RADIUS) continue;
        if (dx * dx + dy * dy < COLLISION_RADIUS_SQ) {
          hit = true;
          break;
        }
      }
    }

    if (hit) p.alive = false;
  }
}

// ── START ROUND ──
function startRound(room) {
  let i = 0;
  for (let id in room.players) {
    const p = room.players[id];
    if (p.lives <= 0) continue; // eliminated players stay dead
    const spawn = spawnConfigs[i % spawnConfigs.length];
    p.x = spawn.x;
    p.y = spawn.y;
    p.angle = spawn.angle;
    p.turning = 0;
    p.trailLen = 0;
    p.trailStart = 0;
    p.trailSentCount = 0;
    p.alive = true;
    i++;
  }
  room.roundActive = true;
  room.countdown = 0;
  room.roundStartTime = Date.now();
  room.needsFullSync = true;
}

// ── COUNTDOWN ──
function startCountdown(room, callback) {
  room.centerPhase = true;
  room.countdown = 3;
  const interval = setInterval(() => {
    room.countdown--;
    if (room.countdown <= 0) {
      clearInterval(interval);
      callback();
    }
  }, 1000);
}

// ── WEBSOCKET ──
wss.on("connection", (ws) => {
  const id = Math.random().toString(36).substr(2, 9);
  ws.id = id;

  ws.send(JSON.stringify({ type: "init", id }));

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      return;
    }

    if (data.type === "create") {
      const code = generateRoomCode();
      rooms[code] = {
        players: {},
        roundActive: false,
        centerPhase: false,
        gameStarted: false,
        matchWinner: null,
        hostId: id,
        countdown: 0,
        roundStartTime: null,
        currentSpeed: BASE_SPEED,
        needsFullSync: false,
        readyPlayers: new Set(),
      };
      ws.room = code;
      rooms[code].players[id] = createPlayer(id, 0, data.name);
      ws.send(JSON.stringify({ type: "roomCreated", code }));
      broadcastPlayerList(code);
    }

    if (data.type === "join") {
      const code = data.code;
      if (!rooms[code]) {
        ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
        return;
      }
      const playerCount = Object.keys(rooms[code].players).length;
      if (playerCount >= 8) {
        ws.send(JSON.stringify({ type: "error", message: "Room is full (max 8)" }));
        return;
      }

      const newPlayer = createPlayer(id, playerCount, data.name);
      if (rooms[code].gameStarted) {
        newPlayer.alive = false;
      }

      rooms[code].players[id] = newPlayer;
      ws.room = code;
      ws.send(JSON.stringify({ type: "joined", code }));

      if (rooms[code].gameStarted) {
        ws.send(JSON.stringify({ type: "gameStart" }));
        rooms[code].needsFullSync = true;
      }
      broadcastPlayerList(code);
    }

    if (data.type === "start") {
      const room = rooms[ws.room];
      if (!room) return;
      if (Object.keys(room.players).length < 2) {
        ws.send(JSON.stringify({ type: "error", message: "Need at least 2 players!" }));
        return;
      }
      if (id !== room.hostId) {
        ws.send(JSON.stringify({ type: "error", message: "Only the host can start" }));
        return;
      }
      room.gameStarted = true;
      broadcastToRoom(ws.room, { type: "gameStart", hostId: room.hostId });
      startCountdown(room, () => {
        startRound(room);
        room.centerPhase = false;
      });
    }

    if (data.type === "restart") {
      const room = rooms[ws.room];
      if (!room || id !== room.hostId) return;
      room.readyPlayers = new Set();
      room.matchWinner = null;
      for (let pid in room.players) {
        room.players[pid].lives = LIVES;
        room.players[pid].trailLen = 0;
        room.players[pid].trailStart = 0;
        room.players[pid].trailSentCount = 0;
        room.players[pid].alive = true;
        room.players[pid].turning = 0;
      }
      broadcastToRoom(ws.room, { type: "matchRestart" });
      startCountdown(room, () => {
        startRound(room);
        room.centerPhase = false;
      });
    }

    if (data.type === "readyUp") {
      const room = rooms[ws.room];
      if (!room || !room.matchWinner) return;
      room.readyPlayers.add(id);
      const totalNonHost = Object.keys(room.players).filter(pid => pid !== room.hostId).length;
      broadcastToRoom(ws.room, { type: "readyCount", ready: room.readyPlayers.size, total: totalNonHost });
    }

    if (data.type === "turn") {
      const room = rooms[ws.room];
      if (!room) return;
      const p = room.players[id];
      if (!p || !p.alive) return;
      if (data.dir === -1 || data.dir === 0 || data.dir === 1) {
        p.turning = data.dir;
      }
    }
  });

  ws.on("close", () => {
    const room = rooms[ws.room];
    if (room) {
      delete room.players[id];
      if (Object.keys(room.players).length === 0) {
        delete rooms[ws.room];
      } else {
        broadcastPlayerList(ws.room);
      }
    }
  });
});

// ── HELPERS ──
function broadcastPlayerList(code) {
  if (!rooms[code]) return;
  const names = {};
  for (let id in rooms[code].players) {
    names[id] = {
      name: rooms[code].players[id].name,
      color: rooms[code].players[id].color,
    };
  }
  broadcastToRoom(code, { type: "playerList", players: names });
}

function broadcastToRoom(code, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.room === code && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ── Extract trail points as compact array for network ──
function getTrailSlice(p, fromIndex, toIndex) {
  const result = [];
  for (let i = fromIndex; i < toIndex; i++) {
    const idx = (p.trailStart + i) % TRAIL_MAX;
    result.push(Math.round(p.trailX[idx] * 10) / 10);
    result.push(Math.round(p.trailY[idx] * 10) / 10);
  }
  return result; // flat [x0,y0,x1,y1,...] — 50% smaller than [{x,y},{x,y}...]
}

// ── GAME LOOP ──
function gameLoop() {
  tickCounter++;
  const shouldBroadcast = tickCounter % BROADCAST_EVERY === 0;

  for (let code in rooms) {
    const room = rooms[code];
    const players = room.players;

    // Physics
    if (room.roundActive) {
      const currentSpeed = getRoomSpeed(room);
      room.currentSpeed = currentSpeed;

      for (let id in players) {
        const p = players[id];
        if (!p.alive) continue;
        movePlayer(p, currentSpeed);
      }

      // Collision check (one pass, no allocations)
      checkCollisions(players);
    }

    // Check round winner
    const playerIds = Object.keys(players);
    const totalPlayers = playerIds.length;
    let aliveCount = 0;
    let lastAlive = null;
    for (let k = 0; k < totalPlayers; k++) {
      if (players[playerIds[k]].alive) {
        aliveCount++;
        lastAlive = players[playerIds[k]];
      }
    }

    if (room.roundActive && totalPlayers >= 2 && aliveCount <= 1) {
      room.roundActive = false;

      // Decrement lives of players who died this round
      for (let id in players) {
        if (!players[id].alive) {
          players[id].lives = Math.max(0, players[id].lives - 1);
        }
      }

      // Count players still in (lives > 0)
      let alive = [];
      for (let id in players) {
        if (players[id].lives > 0) alive.push(players[id]);
      }

      if (alive.length <= 1) {
        // Match over — wait for host to trigger restart
        room.matchWinner = alive.length === 1 ? alive[0].name : "DRAW";
        room.readyPlayers = new Set();
      } else {
        setTimeout(() => {
          startCountdown(room, () => {
            startRound(room);
            room.centerPhase = false;
          });
        }, 2000);
      }
    }

    // Broadcast at throttled rate
    if (!shouldBroadcast) continue;

    const sendFull = room.needsFullSync;
    room.needsFullSync = false;

    const compactPlayers = {};
    for (let id in players) {
      const p = players[id];

      // Delta trail: only send new points since last broadcast
      let trail;
      if (sendFull) {
        trail = getTrailSlice(p, 0, p.trailLen);
        p.trailSentCount = p.trailLen;
      } else {
        trail = getTrailSlice(p, p.trailSentCount, p.trailLen);
        p.trailSentCount = p.trailLen;
      }

      compactPlayers[id] = {
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        a: Math.round(p.angle * 100) / 100,
        t: trail,      // flat [x0,y0,x1,y1,...]
        tl: p.trailLen, // total length for trim sync
        al: p.alive,
        s: p.score,
        lv: p.lives,
        c: p.color,
        n: p.name,
      };
    }

    const roundElapsed = room.roundStartTime
      ? Math.floor((Date.now() - room.roundStartTime) / 1000)
      : 0;

    const state = JSON.stringify({
      type: "state",
      p: compactPlayers,
      w: room.matchWinner,
      hid: room.hostId,
      cn: room.centerPhase,
      cd: room.countdown || 0,
      sp: room.currentSpeed || BASE_SPEED,
      el: roundElapsed,
      f: sendFull || false,
    });

    wss.clients.forEach((client) => {
      if (client.room === code && client.readyState === WebSocket.OPEN) {
        client.send(state);
      }
    });
  }
}

setInterval(gameLoop, 1000 / 60);

server.listen(PORT, () => {
  console.log("Server running http://localhost:" + PORT);
});