// ── Cloudflare Worker Entry Point ──
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const upgradeHeader = request.headers.get("Upgrade");
        if (url.pathname === "/ws" && upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
            const id = env.GAME_SERVER.idFromName("main");
            const obj = env.GAME_SERVER.get(id);
            return obj.fetch(request);
        }
        return env.ASSETS.fetch(request);
    },
};

// ── Game Constants ──
const CANVAS_W = 1400;
const CANVAS_H = 900;
const BASE_SPEED = 4.5;
const SPEED_INCREMENT = 0.8;
const SPEED_INTERVAL = 8;
const MAX_SPEED = 12;
const TURN_SPEED = 0.12;
const TRAIL_MAX = 600;
const COLLISION_RADIUS = 4;
const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;
const COLLISION_SKIP_OWN = 20;
const LIVES = 6;

const BROADCAST_EVERY = 1; // every tick broadcast

const COLORS = ["#ff8c00", "#00bfff", "#ff2e63", "#39ff14", "#e040fb", "#ffeb3b", "#00e5ff", "#ff6e40"];

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

// ── Durable Object: GameServer ──
export class GameServer {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.rooms = {};
        this.sessions = new Map();
        this.gameLoopInterval = null;
        this.tickCounter = 0;
    }

    async fetch(request) {
        try {
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            const response = new Response(null, { status: 101, webSocket: client });
            // Set up session AFTER constructing the response
            this.handleSession(server);
            return response;
        } catch (e) {
            return new Response("WebSocket setup error: " + e.message, { status: 500 });
        }
    }

    handleSession(ws) {
        ws.accept();
        const id = Math.random().toString(36).substr(2, 9);
        const session = { id, ws, room: null };
        this.sessions.set(ws, session);

        this.safeSend(ws, { type: "init", id });

        if (!this.gameLoopInterval) {
            // Defer game loop start to avoid blocking the WebSocket response
            setTimeout(() => {
                if (!this.gameLoopInterval) {
                    this.gameLoopInterval = setInterval(() => {
                        try { this.gameLoop(); } catch (e) { console.error("gameLoop error:", e); }
                    }, 1000 / 30); // 30fps server tick
                }
            }, 0);
        }

        ws.addEventListener("message", (event) => {
            let data;
            try {
                // Handle both string and binary messages
                if (typeof event.data === 'string') {
                    data = JSON.parse(event.data);
                } else if (event.data instanceof ArrayBuffer) {
                    const text = new TextDecoder().decode(event.data);
                    data = JSON.parse(text);
                } else {
                    return;
                }
            } catch (e) { return; }
            try { this.handleMessage(session, data); } catch (e) { console.error("handleMessage error:", e); }
        });

        ws.addEventListener("close", () => {
            this.handleClose(session);
            this.sessions.delete(ws);
            if (this.sessions.size === 0 && this.gameLoopInterval) {
                clearInterval(this.gameLoopInterval);
                this.gameLoopInterval = null;
            }
        });

        ws.addEventListener("error", () => {
            this.handleClose(session);
            this.sessions.delete(ws);
        });
    }

    handleMessage(session, data) {
        const { id, ws } = session;

        if (data.type === "create") {
            const code = this.generateRoomCode();
            this.rooms[code] = {
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
            session.room = code;
            this.rooms[code].players[id] = this.createPlayer(id, 0, data.name);
            this.safeSend(ws, { type: "roomCreated", code });
            this.broadcastPlayerList(code);
        }

        if (data.type === "join") {
            const code = data.code;
            if (!this.rooms[code]) {
                this.safeSend(ws, { type: "error", message: "Room not found" });
                return;
            }
            const playerCount = Object.keys(this.rooms[code].players).length;
            if (playerCount >= 8) {
                this.safeSend(ws, { type: "error", message: "Room is full (max 8)" });
                return;
            }

            const newPlayer = this.createPlayer(id, playerCount, data.name);
            if (this.rooms[code].gameStarted) {
                newPlayer.alive = false;
            }

            this.rooms[code].players[id] = newPlayer;
            session.room = code;
            this.safeSend(ws, { type: "joined", code });

            if (this.rooms[code].gameStarted) {
                this.safeSend(ws, { type: "gameStart", hostId: this.rooms[code].hostId });
                this.rooms[code].needsFullSync = true;
            }
            this.broadcastPlayerList(code);
        }

        if (data.type === "start") {
            const room = this.rooms[session.room];
            if (!room) return;
            if (Object.keys(room.players).length < 2) {
                this.safeSend(ws, { type: "error", message: "Need at least 2 players!" });
                return;
            }
            if (id !== room.hostId) {
                this.safeSend(ws, { type: "error", message: "Only the host can start" });
                return;
            }
            room.gameStarted = true;
            this.broadcastToRoom(session.room, { type: "gameStart", hostId: room.hostId });
            this.startCountdown(room, () => {
                this.startRound(room);
                room.centerPhase = false;
            });
        }

        if (data.type === "restart") {
            const room = this.rooms[session.room];
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
            this.broadcastToRoom(session.room, { type: "matchRestart" });
            this.startCountdown(room, () => {
                this.startRound(room);
                room.centerPhase = false;
            });
        }

        if (data.type === "readyUp") {
            const room = this.rooms[session.room];
            if (!room || !room.matchWinner) return;
            room.readyPlayers.add(id);
            const totalNonHost = Object.keys(room.players).filter(pid => pid !== room.hostId).length;
            this.broadcastToRoom(session.room, { type: "readyCount", ready: room.readyPlayers.size, total: totalNonHost });
        }

        if (data.type === "turn") {
            const room = this.rooms[session.room];
            if (!room) return;
            const p = room.players[id];
            if (!p || !p.alive) return;
            if (data.dir === -1 || data.dir === 0 || data.dir === 1) {
                p.turning = data.dir;
            }
        }
    }

    handleClose(session) {
        const room = this.rooms[session.room];
        if (room) {
            delete room.players[session.id];
            if (Object.keys(room.players).length === 0) {
                delete this.rooms[session.room];
            } else {
                this.broadcastPlayerList(session.room);
            }
        }
    }

    generateRoomCode() {
        let code;
        do {
            code = Math.floor(1000 + Math.random() * 9000).toString();
        } while (this.rooms[code]);
        return code;
    }

    // Trail storage: regular arrays (safe in CF Workers isolates)
    createPlayer(id, index, name) {
        return {
            id,
            name: typeof name === "string" && name.trim().length > 0 ? name.trim() : "Player",
            x: CANVAS_W / 2,
            y: CANVAS_H / 2,
            angle: 0,
            turning: 0,
            trailX: new Array(TRAIL_MAX).fill(0),
            trailY: new Array(TRAIL_MAX).fill(0),
            trailLen: 0,
            trailStart: 0,
            trailSentCount: 0,
            alive: true,
            score: 0,
            lives: LIVES,
            color: COLORS[index % COLORS.length],
            spawnIndex: index,
        };
    }

    getRoomSpeed(room) {
        if (!room.roundStartTime) return BASE_SPEED;
        const elapsed = (Date.now() - room.roundStartTime) / 1000;
        const boosts = Math.floor(elapsed / SPEED_INTERVAL);
        return Math.min(BASE_SPEED + boosts * SPEED_INCREMENT, MAX_SPEED);
    }

    trailPush(p, x, y) {
        if (p.trailLen < TRAIL_MAX) {
            const idx = (p.trailStart + p.trailLen) % TRAIL_MAX;
            p.trailX[idx] = x;
            p.trailY[idx] = y;
            p.trailLen++;
        } else {
            p.trailX[p.trailStart] = x;
            p.trailY[p.trailStart] = y;
            p.trailStart = (p.trailStart + 1) % TRAIL_MAX;
            if (p.trailSentCount > 0) p.trailSentCount--;
        }
    }

    movePlayer(p, speed) {
        p.angle += p.turning * TURN_SPEED;
        p.x += Math.cos(p.angle) * speed;
        p.y += Math.sin(p.angle) * speed;
        this.trailPush(p, p.x, p.y);
        if (p.x < 0 || p.x > CANVAS_W || p.y < 0 || p.y > CANVAS_H) {
            p.alive = false;
        }
    }

    checkCollisions(players) {
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

    getTrailSlice(p, fromIndex, toIndex) {
        const result = [];
        for (let i = fromIndex; i < toIndex; i++) {
            const idx = (p.trailStart + i) % TRAIL_MAX;
            result.push(Math.round(p.trailX[idx] * 10) / 10);
            result.push(Math.round(p.trailY[idx] * 10) / 10);
        }
        return result;
    }

    startRound(room) {
        let i = 0;
        for (let id in room.players) {
            const p = room.players[id];
            if (p.lives <= 0) continue;
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

    startCountdown(room, callback) {
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

    safeSend(ws, data) {
        try {
            ws.send(typeof data === "string" ? data : JSON.stringify(data));
        } catch (e) { /* connection closed */ }
    }

    broadcastPlayerList(code) {
        if (!this.rooms[code]) return;
        const names = {};
        for (let id in this.rooms[code].players) {
            names[id] = {
                name: this.rooms[code].players[id].name,
                color: this.rooms[code].players[id].color,
            };
        }
        this.broadcastToRoom(code, { type: "playerList", players: names });
    }

    broadcastToRoom(code, data) {
        const msg = JSON.stringify(data);
        for (const [ws, session] of this.sessions) {
            if (session.room === code) {
                this.safeSend(ws, msg);
            }
        }
    }

    gameLoop() {
        this.tickCounter++;
        const shouldBroadcast = this.tickCounter % BROADCAST_EVERY === 0;

        for (let code in this.rooms) {
            const room = this.rooms[code];
            const players = room.players;

            if (room.roundActive) {
                const currentSpeed = this.getRoomSpeed(room);
                room.currentSpeed = currentSpeed;

                for (let id in players) {
                    const p = players[id];
                    if (!p.alive) continue;
                    this.movePlayer(p, currentSpeed);
                }

                this.checkCollisions(players);
            }

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
                let stillIn = [];
                for (let id in players) {
                    if (players[id].lives > 0) stillIn.push(players[id]);
                }

                if (stillIn.length <= 1) {
                    // Match over — wait for host to restart
                    room.matchWinner = stillIn.length === 1 ? stillIn[0].name : "DRAW";
                    room.readyPlayers = new Set();
                } else {
                    setTimeout(() => {
                        this.startCountdown(room, () => {
                            this.startRound(room);
                            room.centerPhase = false;
                        });
                    }, 2000);
                }
            }

            if (!shouldBroadcast) continue;

            const sendFull = room.needsFullSync;
            room.needsFullSync = false;

            const compactPlayers = {};
            for (let id in players) {
                const p = players[id];

                let trail;
                if (sendFull) {
                    trail = this.getTrailSlice(p, 0, p.trailLen);
                    p.trailSentCount = p.trailLen;
                } else {
                    trail = this.getTrailSlice(p, p.trailSentCount, p.trailLen);
                    p.trailSentCount = p.trailLen;
                }

                compactPlayers[id] = {
                    x: Math.round(p.x * 10) / 10,
                    y: Math.round(p.y * 10) / 10,
                    a: Math.round(p.angle * 100) / 100,
                    t: trail,
                    tl: p.trailLen,
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

            for (const [ws, session] of this.sessions) {
                if (session.room === code) {
                    try { ws.send(state); } catch (e) { }
                }
            }
        }
    }
}