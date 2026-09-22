const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const SIZE = 6;
const PLAYERS = ['milk', 'mocha'];

// Lines keyed by [speaker owner]-[speaker's role in this boop: 'booper' or 'booped'].
// Milk is energetic/chatty; Mocha stays true to being stoic/mute, reacting in symbols/actions instead of words.
const BOOP_LINES = {
  'milk-booper': ['Boop! Gotcha!', 'Hehe, out of my way!', 'Tag, you’re it!', 'Wheee, boop!'],
  'milk-booped': ['Hey!!', 'Whoa, watch it!', 'Not fair!', 'Ow, my nose!'],
  'mocha-booper': ['...!', '( ´∀｀ )', '...boop.'],
  'mocha-booped': ['...!', '( ´∅｀ )', '...!!'],
};

function pickBoopLine(placedBy, boopedPieces) {
  if (!boopedPieces || boopedPieces.length === 0) return null;
  const target = boopedPieces[Math.floor(Math.random() * boopedPieces.length)];
  const speakerIsBooper = Math.random() < 0.5;
  const speaker = speakerIsBooper ? placedBy : target;
  const role = speakerIsBooper ? 'booper' : 'booped';
  const lines = BOOP_LINES[`${speaker.owner}-${role}`] || (speaker.owner === 'mocha' ? ['...'] : ['Boop!']);
  const text = lines[Math.floor(Math.random() * lines.length)];
  return { text, at: speaker.at };
}

const MIME = {
  '.html': 'text/html',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, decodeURIComponent(filePath.split('?')[0]));
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Map(); // ws -> { role }
    this.seatsTaken = { milk: false, mocha: false };
    this.resetGame();
  }

  resetGame() {
    this.board = emptyBoard();
    this.pools = {
      milk: { kitten: 8, cat: 0 },
      mocha: { kitten: 8, cat: 0 },
    };
    this.current = 'milk';
    this.gameOver = false;
    this.winner = null;
    this.pendingGraduationGroups = null;
    this.pendingEightPiece = false;
    this.eightPieceMode = null;
    this.lastMove = null; // { placedAt: [r,c], movedTo: [[r,c], ...] } for the last-turn highlight
    // undo window: snapshot from just before the last move, plus who made that move.
    // Only that same mover can undo it, and only until the OTHER player moves
    // (which replaces this with their own move's snapshot instead).
    this.undoWindow = null; // { snapshot, mover }
    this.undosUsed = { milk: 0, mocha: 0 };
  }

  snapshot() {
    return {
      board: JSON.parse(JSON.stringify(this.board)),
      pools: JSON.parse(JSON.stringify(this.pools)),
      current: this.current,
      gameOver: this.gameOver,
      winner: this.winner,
      pendingGraduationGroups: this.pendingGraduationGroups ? JSON.parse(JSON.stringify(this.pendingGraduationGroups)) : null,
      pendingEightPiece: this.pendingEightPiece,
      eightPieceMode: this.eightPieceMode,
      lastMove: this.lastMove ? JSON.parse(JSON.stringify(this.lastMove)) : null,
    };
  }

  openUndoWindow(mover) {
    this.undoWindow = { snapshot: this.snapshot(), mover };
  }

  undo(role) {
    if (role !== 'milk' && role !== 'mocha') return { ok: false };
    if (this.gameOver) return { ok: false };
    if (!this.undoWindow || this.undoWindow.mover !== role) return { ok: false }; // only the mover, only before opponent responds
    if (this.undosUsed[role] >= 3) return { ok: false };
    Object.assign(this, this.undoWindow.snapshot);
    this.undoWindow = null;
    this.undosUsed[role]++;
    return { ok: true };
  }

  totalActivePieces(player) {
    let onBoard = 0;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (this.board[r][c] && this.board[r][c].owner === player) onBoard++;
    return onBoard + this.pools[player].kitten + this.pools[player].cat;
  }

  resolveBoops(pr, pc) {
    const placed = this.board[pr][pc];
    const moves = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = pr + dr, c = pc + dc;
        if (!inBounds(r, c)) continue;
        const target = this.board[r][c];
        if (!target) continue;
        if (placed.type === 'kitten' && target.type === 'cat') continue;
        const nr = r + dr, nc = c + dc;
        moves.push({ from: [r, c], to: [nr, nc], piece: target });
      }
    }
    let boopedAny = false;
    const fellOff = [];
    const boopedPieces = [];
    for (const mv of moves) {
      const [r, c] = mv.from;
      const cur = this.board[r][c];
      if (!cur || cur.owner !== mv.piece.owner || cur.type !== mv.piece.type) continue;
      const [nr, nc] = mv.to;
      if (!inBounds(nr, nc)) {
        this.pools[cur.owner][cur.type]++;
        this.board[r][c] = null;
        boopedAny = true;
        fellOff.push({ from: [r, c], to: [nr, nc], owner: cur.owner, type: cur.type });
        // fallen-off pieces don't get a speech line — they're gone from the board by the time it would show
      } else if (this.board[nr][nc]) {
        // occupied, stays
      } else {
        this.board[nr][nc] = cur;
        this.board[r][c] = null;
        boopedAny = true;
        boopedPieces.push({ owner: cur.owner, type: cur.type, at: [nr, nc] });
      }
    }
    return { boopedAny, fellOff, boopedPieces, placedBy: { owner: placed.owner, type: placed.type, at: [pr, pc] } };
  }

  linesOfThree(player) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    const found = [];
    const seen = new Set();
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!this.board[r][c] || this.board[r][c].owner !== player) continue;
        for (const [dr, dc] of dirs) {
          const cells = [[r, c], [r + dr, c + dc], [r + 2 * dr, c + 2 * dc]];
          if (cells.every(([rr, cc]) => inBounds(rr, cc) && this.board[rr][cc] && this.board[rr][cc].owner === player)) {
            const key = cells.map(p => p.join(',')).sort().join('|');
            if (!seen.has(key)) {
              seen.add(key);
              found.push(cells);
            }
          }
        }
      }
    }
    return found;
  }

  checkWin(player) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        for (const [dr, dc] of dirs) {
          const cells = [[r, c], [r + dr, c + dc], [r + 2 * dr, c + 2 * dc]];
          if (cells.every(([rr, cc]) => inBounds(rr, cc) && this.board[rr][cc] && this.board[rr][cc].owner === player && this.board[rr][cc].type === 'cat')) {
            return true;
          }
        }
      }
    }
    let onBoardCats = 0, onBoardTotal = 0;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (this.board[r][c] && this.board[r][c].owner === player) {
          onBoardTotal++;
          if (this.board[r][c].type === 'cat') onBoardCats++;
        }
    if (onBoardTotal === 8 && onBoardCats === 8) return true;
    return false;
  }

  boardHasType(player, type) {
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (this.board[r][c] && this.board[r][c].owner === player && this.board[r][c].type === type) return true;
    return false;
  }

  declareWin(winner) {
    this.gameOver = true;
    this.winner = winner;
  }

  finishTurn() {
    if (this.checkWin(this.current)) {
      this.declareWin(this.current);
      return;
    }
    this.current = this.current === 'milk' ? 'mocha' : 'milk';
  }

  checkEightPieceOnly() {
    const player = this.current;
    const allEightOnBoard = this.totalActivePieces(player) === 8 && this.pools[player].kitten === 0 && this.pools[player].cat === 0;
    if (allEightOnBoard) {
      this.pendingEightPiece = true;
    } else {
      this.finishTurn();
    }
  }

  checkGraduationAndEight() {
    const player = this.current;

    if (this.checkWin(player)) {
      this.declareWin(player);
      return;
    }

    const groups = this.linesOfThree(player);
    const allEightOnBoard = this.totalActivePieces(player) === 8 && this.pools[player].kitten === 0 && this.pools[player].cat === 0;

    if (groups.length > 0) {
      this.pendingGraduationGroups = groups;
      return;
    }
    if (allEightOnBoard) {
      this.pendingEightPiece = true;
      return;
    }
    this.finishTurn();
  }

  placePiece(role, r, c, type) {
    if (this.gameOver) return { ok: false };
    if (this.pendingGraduationGroups || this.pendingEightPiece) return { ok: false };
    if (role !== this.current) return { ok: false };
    if (this.board[r][c]) return { ok: false };
    if (this.pools[role][type] <= 0) return { ok: false };

    this.openUndoWindow(role);
    this.pools[role][type]--;
    this.board[r][c] = { owner: role, type };

    const { boopedAny, fellOff, boopedPieces, placedBy } = this.resolveBoops(r, c);
    const speechLine = boopedAny ? pickBoopLine(placedBy, boopedPieces) : null;

    this.lastMove = {
      placedAt: [r, c],
      movedTo: boopedPieces.map(p => p.at),
    };

    this.checkGraduationAndEight();

    return { ok: true, effects: { boopedAny, fellOff, speechLine } };
  }

  applyGraduation(role, groupIndex) {
    if (role !== this.current || !this.pendingGraduationGroups) return { ok: false };
    const cells = this.pendingGraduationGroups[groupIndex];
    if (!cells) return { ok: false };
    for (const [r, c] of cells) {
      this.board[r][c] = null;
      this.pools[role].cat++;
    }
    this.pendingGraduationGroups = null;
    this.checkEightPieceOnly();
    return { ok: true };
  }

  skipGraduation(role) {
    if (role !== this.current || !this.pendingGraduationGroups) return { ok: false };
    this.pendingGraduationGroups = null;
    this.checkEightPieceOnly();
    return { ok: true };
  }

  eightPieceChoose(role, mode) {
    if (role !== this.current || !this.pendingEightPiece) return { ok: false };
    this.eightPieceMode = mode;
    return { ok: true };
  }

  eightPieceSkip(role) {
    if (role !== this.current || !this.pendingEightPiece) return { ok: false };
    this.pendingEightPiece = false;
    this.eightPieceMode = null;
    this.finishTurn();
    return { ok: true };
  }

  eightPieceCellClick(role, r, c) {
    if (role !== this.current || !this.pendingEightPiece || !this.eightPieceMode) return { ok: false };
    const p = this.board[r][c];
    if (!p || p.owner !== role) return { ok: false };
    if (this.eightPieceMode === 'graduate' && p.type === 'kitten') {
      this.board[r][c] = null;
      this.pools[role].cat++;
    } else if (this.eightPieceMode === 'retrieve' && p.type === 'cat') {
      this.board[r][c] = null;
      this.pools[role].cat++;
    } else {
      return { ok: false };
    }
    this.pendingEightPiece = false;
    this.eightPieceMode = null;
    this.finishTurn();
    return { ok: true };
  }

  serializeState() {
    return {
      type: 'state',
      board: this.board,
      pools: this.pools,
      current: this.current,
      gameOver: this.gameOver,
      winner: this.winner,
      pendingGraduationGroups: this.pendingGraduationGroups,
      pendingEightPiece: this.pendingEightPiece,
      eightPieceMode: this.eightPieceMode,
      hasKittenOnBoard: this.pendingEightPiece ? this.boardHasType(this.current, 'kitten') : false,
      hasCatOnBoard: this.pendingEightPiece ? this.boardHasType(this.current, 'cat') : false,
      undosLeft: { milk: 3 - this.undosUsed.milk, mocha: 3 - this.undosUsed.mocha },
      undoAvailableFor: this.undoWindow && !this.gameOver ? this.undoWindow.mover : null,
      lastMove: this.lastMove,
    };
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  broadcastState() {
    this.broadcast(this.serializeState());
  }

  assignRole() {
    if (!this.seatsTaken.milk) {
      this.seatsTaken.milk = true;
      return 'milk';
    }
    if (!this.seatsTaken.mocha) {
      this.seatsTaken.mocha = true;
      return 'mocha';
    }
    return 'spectator';
  }

  // resets the game and kicks everyone back to the room-entry screen
  resetAndKick() {
    this.resetGame();
    this.seatsTaken = { milk: false, mocha: false };
    this.broadcast({ type: 'kicked' });
    for (const ws of this.clients.keys()) {
      ws.close();
    }
    this.clients.clear();
  }
}

const rooms = new Map(); // code -> Room

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, new Room(code));
  }
  return rooms.get(code);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = (url.searchParams.get('room') || '').trim();

  if (!/^\d{4}$/.test(code)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid room code' }));
    ws.close();
    return;
  }

  const room = getOrCreateRoom(code);
  const role = room.assignRole();
  room.clients.set(ws, { role });
  ws.__room = room;

  ws.send(JSON.stringify({ type: 'assigned', role, code }));
  ws.send(JSON.stringify(room.serializeState()));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const client = room.clients.get(ws);
    if (!client) return;
    const role = client.role;

    if (msg.action === 'place') {
      const result = room.placePiece(role, msg.r, msg.c, msg.pieceType);
      if (result.ok) {
        room.broadcast({ type: 'effects', ...result.effects, r: msg.r, c: msg.c });
        room.broadcastState();
      }
    } else if (msg.action === 'graduate') {
      const result = room.applyGraduation(role, msg.groupIndex);
      if (result.ok) room.broadcastState();
    } else if (msg.action === 'skipGraduation') {
      const result = room.skipGraduation(role);
      if (result.ok) room.broadcastState();
    } else if (msg.action === 'eightChoose') {
      const result = room.eightPieceChoose(role, msg.mode);
      if (result.ok) room.broadcastState();
    } else if (msg.action === 'eightSkip') {
      const result = room.eightPieceSkip(role);
      if (result.ok) room.broadcastState();
    } else if (msg.action === 'eightCellClick') {
      const result = room.eightPieceCellClick(role, msg.r, msg.c);
      if (result.ok) room.broadcastState();
    } else if (msg.action === 'newGame') {
      room.resetGame();
      room.broadcastState();
    } else if (msg.action === 'undo') {
      const result = room.undo(role);
      if (result.ok) room.broadcastState();
    } else if (msg.action === 'resetAndKick') {
      room.resetAndKick();
      if (room.clients.size === 0 && room.seatsTaken.milk === false && room.seatsTaken.mocha === false) {
        rooms.delete(room.code);
      }
    }
  });

  ws.on('close', () => {
    const client = room.clients.get(ws);
    if (client && (client.role === 'milk' || client.role === 'mocha')) {
      room.seatsTaken[client.role] = false;
    }
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      rooms.delete(room.code);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Boop server running at http://0.0.0.0:${PORT}`);
});
