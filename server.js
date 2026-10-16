/*
 * 局域网五子棋联机服务器(零依赖,Node >= 16)
 * 用法: node server.js [端口]   默认端口 3000
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.argv[2]) || 3000; // 可选:node server.js 8080
const PUBLIC_DIR = path.join(__dirname, 'public');
const SIZE = 15; // 15x15 棋盘

/* ---------------- 静态文件服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- 原生 WebSocket 实现 ---------------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

// 解析一帧,返回 {fin, opcode, payload} 或 null(数据不足)
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, frameLength: offset + len };
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/* ---------------- 游戏与房间 ---------------- */
const rooms = new Map(); // code -> room

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function newBoard() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
}

function checkWin(board, x, y) {
  const color = board[y][x];
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    const line = [[x, y]];
    for (const sign of [1, -1]) {
      let nx = x + dx * sign, ny = y + dy * sign;
      while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[ny][nx] === color) {
        line.push([nx, ny]);
        nx += dx * sign; ny += dy * sign;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

function createRoom(hostWs, name) {
  const code = makeRoomCode();
  const room = {
    code,
    players: [null, null], // [黑, 白]
    board: newBoard(),
    moves: [],
    turn: 1,               // 1=黑 2=白
    started: false,
    gameOver: false,
    restartReady: new Set(),
  };
  joinRoom(room, hostWs, name);
  send(hostWs, { type: 'created', room: code });
  return room;
}

function joinRoom(room, ws, name) {
  ws.room = room;
  ws.name = name;
  ws.color = room.players[0] ? 2 : 1; // 房主执黑
  const slot = ws.color - 1;
  room.players[slot] = ws;
  send(ws, { type: 'joined', room: room.code, color: ws.color });

  if (room.players[0] && room.players[1] && !room.started) {
    room.started = true;
    broadcast(room, {
      type: 'start',
      black: room.players[0].name,
      white: room.players[1].name,
      turn: room.turn,
    });
  }
}

function send(ws, obj) {
  if (ws && ws.alive) ws.socket.write(encodeFrame(JSON.stringify(obj)));
}

function broadcast(room, obj, exceptWs) {
  for (const p of room.players) {
    if (p && p !== exceptWs) send(p, obj);
  }
}

function handleMove(ws, msg) {
  const room = ws.room;
  if (!room || !room.started || room.gameOver) return;
  if (ws.color !== room.turn) return send(ws, { type: 'error', msg: '还没轮到你落子' });
  const { x, y } = msg;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  if (room.board[y][x] !== 0) return send(ws, { type: 'error', msg: '这个位置已经有棋子了' });

  room.board[y][x] = ws.color;
  room.moves.push({ x, y, color: ws.color });
  const winLine = checkWin(room.board, x, y);

  if (winLine) {
    room.gameOver = true;
    broadcast(room, { type: 'move', x, y, color: ws.color, turn: 0 });
    broadcast(room, { type: 'win', color: ws.color, line: winLine, winner: ws.name });
  } else if (room.moves.length === SIZE * SIZE) {
    room.gameOver = true;
    broadcast(room, { type: 'move', x, y, color: ws.color, turn: 0 });
    broadcast(room, { type: 'draw' });
  } else {
    room.turn = 3 - room.turn;
    broadcast(room, { type: 'move', x, y, color: ws.color, turn: room.turn });
  }
}

// 悔棋:对方同意后,回退到轮到请求方落子的状态
function applyUndo(room, requester) {
  if (room.moves.length === 0) return;
  let steps = room.moves[room.moves.length - 1].color === requester.color ? 1 : 2;
  steps = Math.min(steps, room.moves.length);
  const removed = [];
  for (let i = 0; i < steps; i++) {
    const m = room.moves.pop();
    room.board[m.y][m.x] = 0;
    removed.push(m);
  }
  room.turn = requester.color;
  room.gameOver = false;
  room.restartReady.clear();
  broadcast(room, { type: 'undo', moves: removed, turn: room.turn });
}

function resetRoom(room) {
  room.board = newBoard();
  room.moves = [];
  room.turn = 1;
  room.gameOver = false;
  room.restartReady.clear();
  // 双方交换黑白
  const [black, white] = room.players;
  if (black) black.color = 2;
  if (white) white.color = 1;
  room.players = [white, black];
  for (const p of room.players) {
    if (p) send(p, { type: 'joined', room: room.code, color: p.color });
  }
  broadcast(room, {
    type: 'start',
    black: room.players[0].name,
    white: room.players[1].name,
    turn: room.turn,
  });
}

function handleLeave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  const idx = room.players.indexOf(ws);
  if (idx !== -1) room.players[idx] = null;
  const other = room.players.find(Boolean);
  if (other) {
    if (!room.gameOver && room.started) {
      room.gameOver = true;
      send(other, { type: 'opponent_left', winner: other.name });
    } else {
      send(other, { type: 'opponent_left' });
    }
  }
  if (!room.players.some(Boolean)) rooms.delete(room.code);
}

/* ---------------- 消息分发 ---------------- */
function onMessage(ws, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  switch (msg.type) {
    case 'create': {
      const name = String(msg.name || '玩家').slice(0, 12);
      const room = createRoom(ws, name);
      rooms.set(room.code, room);
      break;
    }
    case 'join': {
      const code = String(msg.room || '').toUpperCase().trim();
      const room = rooms.get(code);
      const name = String(msg.name || '玩家').slice(0, 12);
      if (!room) return send(ws, { type: 'error', msg: '房间不存在,请检查房间码' });
      if (room.players.every(Boolean)) return send(ws, { type: 'error', msg: '房间已满(两人对局)' });
      joinRoom(room, ws, name);
      break;
    }
    case 'move': handleMove(ws, msg); break;
    case 'chat': {
      const text = String(msg.text || '').slice(0, 200);
      if (text) broadcast(ws.room, { type: 'chat', from: ws.name, text, color: ws.color }, null);
      break;
    }
    case 'undo_request': {
      if (!ws.room || ws.room.gameOver || !ws.room.started) return;
      const other = ws.room.players.find(p => p && p !== ws);
      if (other) send(other, { type: 'undo_request', from: ws.name });
      break;
    }
    case 'undo_response': {
      const other = ws.room && ws.room.players.find(p => p && p !== ws);
      if (other) {
        send(other, { type: 'undo_result', agree: !!msg.agree });
        if (msg.agree) applyUndo(ws.room, other); // other 是请求方
      }
      break;
    }
    case 'resign': {
      const room = ws.room;
      if (!room || !room.started || room.gameOver) return;
      room.gameOver = true;
      const other = room.players.find(p => p && p !== ws);
      broadcast(room, { type: 'resign', loser: ws.name, winner: other ? other.name : '' });
      break;
    }
    case 'restart': {
      const room = ws.room;
      if (!room || !room.started || !room.gameOver) return;
      room.restartReady.add(ws);
      const other = room.players.find(p => p && p !== ws);
      if (other) send(other, { type: 'restart_request', from: ws.name });
      if (room.players.filter(Boolean).length === 2 && room.players.every(p => room.restartReady.has(p))) {
        resetRoom(room);
      }
      break;
    }
    case 'ping_ws': send(ws, { type: 'pong_ws' }); break;
  }
}

/* ---------------- WebSocket 接入 ---------------- */
server.on('upgrade', (req, socket) => {
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();
  acceptUpgrade(req, socket);
  socket.setNoDelay(true);

  const client = { socket, alive: true, room: null, name: '', color: 0 };
  let buffer = Buffer.alloc(0);
  let fragments = null;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const frame = parseFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.frameLength);
      switch (frame.opcode) {
        case 0x1: case 0x2: // 文本/二进制消息(支持分片)
          if (frame.fin) {
            const data = fragments ? Buffer.concat([fragments, frame.payload]) : frame.payload;
            fragments = null;
            onMessage(client, data.toString('utf8'));
          } else {
            fragments = fragments ? Buffer.concat([fragments, frame.payload]) : frame.payload;
          }
          break;
        case 0x8: // close
          client.alive = false;
          handleLeave(client);
          try {
            socket.write(Buffer.from([0x88, 0]));
            socket.end();
          } catch {}
          return;
        case 0x9: // ping -> pong
          socket.write(Buffer.from([0x8a, 0]));
          break;
        case 0xa: break; // pong
      }
    }
  });

  socket.on('close', () => { client.alive = false; handleLeave(client); });
  socket.on('error', () => { client.alive = false; try { socket.destroy(); } catch {} });
});

/* ---------------- 启动(端口被占用时自动尝试下一个) ---------------- */
const BASE_PORT = PORT; // 可通过命令行参数指定起始端口
const MAX_TRIES = 20;

function listen(port, triesLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`端口 ${port} 已被占用,尝试 ${port + 1} …`);
      listen(port + 1, triesLeft - 1);
    } else {
      console.error('服务器启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0');
}

server.on('listening', () => {
  const port = server.address().port;
  console.log('┌─────────────────────────────────────────────┐');
  console.log('  五子棋联机服务器已启动');
  console.log(`  本机访问:   http://localhost:${port}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  局域网访问: http://${net.address}:${port}  (${name})`);
      }
    }
  }
  console.log('  把"局域网访问"地址发给同一 WiFi/网段的朋友即可对局');
  console.log('└─────────────────────────────────────────────┘');
});

listen(BASE_PORT, MAX_TRIES);
