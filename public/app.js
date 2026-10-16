/* ============ 全局状态 ============ */
const SIZE = 15;
const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  connected: false,
  name: localStorage.getItem('gomoku_name') || '',
  room: '',
  color: 0,            // 1=黑 2=白
  board: [],
  turn: 0,
  gameOver: false,
  started: false,
  lastMove: null,
  moves: [],
  winLine: null,
  myTurnNotified: false,
  restartClicked: false,
};

const ui = {
  screen: null,
  canvas: $('board'),
  ctx: $('board').getContext('2d'),
  hoverCell: null,     // {x, y}
  animT: 1,            // 最新棋子动画进度
  animating: false,
  soundOn: localStorage.getItem('gomoku_sound') !== '0',
};

const QUICK_CHAT = ['你好！', '请多指教~', '妙啊！', '好棋！', '快点呀~', '悔棋一下', '承让承让', '再来！'];

/* ============ 工具 ============ */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
  ui.screen = name;
}

function toast(text, ms = 2400) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function showModal({ icon, title, titleClass = '', desc, actions }) {
  $('modal-icon').textContent = icon;
  const t = $('modal-title');
  t.textContent = title;
  t.className = 'modal-title ' + titleClass;
  $('modal-desc').innerHTML = desc;
  const box = $('modal-actions');
  box.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (a.cls || 'btn-ghost');
    btn.textContent = a.text;
    btn.onclick = () => { $('modal').classList.add('hidden'); a.onClick && a.onClick(); };
    box.appendChild(btn);
  }
  $('modal').classList.remove('hidden');
}

function hideModal() { $('modal').classList.add('hidden'); }

function statusText(text, highlight = false) {
  const el = $('status-text');
  el.textContent = text;
  el.classList.toggle('highlight', highlight);
}

function role() { return state.color === 1 ? '黑棋' : '白棋'; }
function otherRole() { return state.color === 1 ? '白棋' : '黑棋'; }

/* ============ 音效(WebAudio 合成,无外部资源) ============ */
let audioCtx = null;
function playTone(freq, dur, type = 'sine', gain = 0.15, delay = 0) {
  if (!ui.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type; osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t); osc.stop(t + dur);
  } catch {}
}
function sndPlace() { playTone(190, 0.12, 'triangle', 0.4); playTone(520, 0.06, 'sine', 0.1); }
function sndWin() { [523, 659, 784, 1047].forEach((f, i) => playTone(f, 0.35, 'sine', 0.16, i * 0.13)); }
function sndLose() { [392, 330, 262].forEach((f, i) => playTone(f, 0.3, 'sine', 0.13, i * 0.16)); }
function sndMsg() { playTone(880, 0.08, 'sine', 0.08); }

/* ============ WebSocket ============ */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.onopen = () => { state.connected = true; };
  ws.onclose = () => {
    state.connected = false;
    if (ui.screen === 'game' || ui.screen === 'lobby') {
      showModal({
        icon: '📡', title: '连接已断开',
        desc: '与服务器的连接断开了,<br>请刷新页面重新进入',
        actions: [{ text: '刷新页面', cls: 'btn-primary', onClick: () => location.reload() }],
      });
    }
  };
  ws.onmessage = (e) => handleMsg(JSON.parse(e.data));
}

function send(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

/* ============ 服务器消息处理 ============ */
function handleMsg(msg) {
  switch (msg.type) {
    case 'created':
      state.room = msg.room;
      $('lobby-code').textContent = msg.room;
      showScreen('lobby');
      break;

    case 'joined':
      state.room = msg.room;
      state.color = msg.color;
      updatePlayersUI();
      break;

    case 'start':
      state.started = true;
      state.board = emptyBoard();
      state.turn = msg.turn;
      state.gameOver = false;
      state.lastMove = null;
      state.winLine = null;
      state.restartClicked = false;
      state.moves = [];
      const rbtn = $('btn-restart');
      rbtn.disabled = false;
      rbtn.textContent = '🔄 再来一局';
      rbtn.classList.add('hidden');
      $('name-black').textContent = msg.black;
      $('name-white').textContent = msg.white;
      $('sub-black').textContent = '执黑先行';
      $('sub-white').textContent = '执白后行';
      $('sub-black').classList.toggle('me', state.color === 1);
      $('sub-white').classList.toggle('me', state.color === 2);
      $('board-overlay').classList.add('hidden');
      $('chat-list').innerHTML = '<div class="chat-sys">对局开始,愿你旗开得胜 🎉</div>';
      updateTurnUI();
      showScreen('game');
      resizeCanvas();
      break;

    case 'move': {
      const { x, y, color, turn } = msg;
      state.board[y][x] = color;
      state.lastMove = { x, y };
      state.moves.push({ x, y, color });
      state.turn = turn;
      // 启动落子动画
      ui.animT = 0;
      if (!ui.animating) { ui.animating = true; requestAnimationFrame(animLoop); }
      sndPlace();
      updateTurnUI();
      break;
    }

    case 'win': {
      state.gameOver = true;
      state.winLine = msg.line.map(([x, y]) => ({ x, y }));
      state.turn = 0;
      drawBoard();
      const iWin = msg.color === state.color;
      setTimeout(() => {
        iWin ? sndWin() : sndLose();
        showModal({
          icon: iWin ? '🏆' : '🤍',
          title: iWin ? '胜 利' : '惜 败',
          titleClass: iWin ? 'win' : 'lose',
          desc: iWin
            ? `${role()}五连成线,你击败了对手!<br>共 ${state.board.flat().filter(v => v).length} 手`
            : `对手${msg.winner === '' ? '' : '(' + msg.winner + ')'}率先连成五子,<br>复盘再来,胜负未定!`,
          actions: [
            { text: '🔄 再来一局', cls: 'btn-gold', onClick: requestRestart },
            { text: '稍后', onClick: () => $('btn-restart').classList.remove('hidden') },
          ],
        });
        $('btn-restart').classList.remove('hidden');
        updateTurnUI();
      }, 700);
      break;
    }

    case 'draw':
      state.gameOver = true;
      state.turn = 0;
      drawBoard();
      setTimeout(() => {
        showModal({
          icon: '🤝', title: '平 局',
          desc: '棋盘已满,势均力敌!',
          actions: [{ text: '🔄 再来一局', cls: 'btn-gold', onClick: requestRestart }],
        });
        $('btn-restart').classList.remove('hidden');
        updateTurnUI();
      }, 500);
      break;

    case 'undo_request':
      sndMsg();
      showModal({
        icon: '🤚', title: '悔棋请求',
        desc: `对手 <b>${msg.from}</b> 请求悔一手棋,<br>是否同意?`,
        actions: [
          { text: '同意', cls: 'btn-primary', onClick: () => send({ type: 'undo_response', agree: true }) },
          { text: '拒绝', cls: 'btn-ghost', onClick: () => send({ type: 'undo_response', agree: false }) },
        ],
      });
      break;

    case 'undo_result':
      toast(msg.agree ? '对方同意了你的悔棋请求' : '对方拒绝了你的悔棋请求');
      break;

    case 'undo':
      for (const m of msg.moves) state.board[m.y][m.x] = 0;
      state.moves.length = Math.max(0, state.moves.length - msg.moves.length);
      state.lastMove = state.moves.length ? state.moves[state.moves.length - 1] : null;
      state.turn = msg.turn;
      state.gameOver = false;
      state.winLine = null;
      state.restartClicked = false;
      $('btn-restart').classList.add('hidden');
      addChatSys(msg.moves.length === 2 ? '悔棋两步,重新落子' : '悔棋一步,重新落子');
      drawBoard();
      updateTurnUI();
      break;

    case 'resign':
      state.gameOver = true;
      state.turn = 0;
      updateTurnUI();
      addChatSys(`${msg.loser} 认输,${msg.winner} 获胜`);
      showModal({
        icon: '🏳️', title: '对局结束',
        titleClass: 'win',
        desc: `${msg.loser} 投子认输,${msg.winner} 获得胜利!`,
        actions: [
          { text: '🔄 再来一局', cls: 'btn-gold', onClick: requestRestart },
          { text: '稍后', onClick: () => $('btn-restart').classList.remove('hidden') },
        ],
      });
      $('btn-restart').classList.remove('hidden');
      break;

    case 'restart_request':
      toast(`${msg.from} 想再来一局,点击「再来一局」开始`);
      sndMsg();
      break;

    case 'opponent_left':
      if (state.gameOver || !state.started) {
        toast('对方已离开房间');
      } else {
        state.gameOver = true;
        state.turn = 0;
        updateTurnUI();
        sndWin();
        showModal({
          icon: '👋', title: '对手离线', titleClass: 'win',
          desc: '对手离开了对局,本局你获胜!',
          actions: [{ text: '知道了', cls: 'btn-primary' }],
        });
      }
      break;

    case 'chat':
      addChat(msg.from, msg.text, msg.color === state.color ? 'self' : 'op');
      sndMsg();
      break;

    case 'error':
      toast('⚠️ ' + msg.msg);
      break;
  }
}

/* ============ UI 更新 ============ */
function updatePlayersUI() {
  $('room-chip-code').textContent = state.room || '----';
}

function updateTurnUI() {
  const blackCard = $('pcard-black'), whiteCard = $('pcard-white');
  blackCard.classList.toggle('active', state.started && !state.gameOver && state.turn === 1);
  whiteCard.classList.toggle('active', state.started && !state.gameOver && state.turn === 2);

  if (!state.started) { statusText('等待对手加入…'); return; }
  if (state.gameOver) { statusText('对局结束'); return; }

  const myTurn = state.turn === state.color;
  statusText(myTurn ? `轮到你了 —— ${role()}落子` : `等待对手 —— ${otherRole()}思考中…`, myTurn);

  // 落子提醒音(轮到自己时轻响一次)
  if (myTurn && !state.myTurnNotified) { playTone(660, 0.1, 'sine', 0.1); }
  state.myTurnNotified = myTurn;
}

/* ============ 聊天 ============ */
function addChat(name, text, cls = '') {
  const list = $('chat-list');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + cls;
  div.innerHTML = `<div class="chat-name ${cls === 'op' ? 'op' : ''}"></div><div class="bubble"></div>`;
  div.querySelector('.chat-name').textContent = name;
  div.querySelector('.bubble').textContent = text;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function addChatSys(text) {
  const list = $('chat-list');
  const div = document.createElement('div');
  div.className = 'chat-sys';
  div.textContent = text;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

/* ============ 棋盘渲染 ============ */
function emptyBoard() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
}

let CELL = 0, PAD = 0, BOARD_PX = 0;

function resizeCanvas() {
  const canvas = ui.canvas;
  const parentW = canvas.parentElement.clientWidth - 2 * clampVal(parseFloat(getComputedStyle(canvas.parentElement).paddingLeft), 0, 20);
  const size = Math.max(280, Math.min(parentW, 680, window.innerHeight - 230));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ui.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  BOARD_PX = size;
  CELL = size / (SIZE + 1);
  PAD = CELL;
  drawBoard();
}
function clampVal(v, a, b) { return Math.max(a, Math.min(b, v)); }

// 固定伪随机种子,保证木纹稳定
function seededRandom(seed) {
  return () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

function drawWood(ctx) {
  const w = BOARD_PX;
  const g = ctx.createLinearGradient(0, 0, w, w);
  g.addColorStop(0, '#e3b06e');
  g.addColorStop(0.5, '#d69c54');
  g.addColorStop(1, '#c98f47');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, w);

  const rand = seededRandom(42);
  ctx.strokeStyle = 'rgba(120, 70, 20, 0.08)';
  for (let i = 0; i < 46; i++) {
    const y = rand() * w;
    ctx.lineWidth = 0.6 + rand() * 1.8;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.3, y + (rand() - 0.5) * 14, w * 0.7, y + (rand() - 0.5) * 14, w, y + (rand() - 0.5) * 8);
    ctx.stroke();
  }
  // 内阴影边缘
  const edge = ctx.createLinearGradient(0, 0, 0, w);
  edge.addColorStop(0, 'rgba(80, 45, 10, .18)');
  edge.addColorStop(0.06, 'rgba(80, 45, 10, 0)');
  edge.addColorStop(0.94, 'rgba(80, 45, 10, 0)');
  edge.addColorStop(1, 'rgba(80, 45, 10, .22)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, w);
}

function gridXY(i) { return PAD + i * CELL; }

function drawBoard() {
  const ctx = ui.ctx;
  if (!BOARD_PX) return;
  ctx.clearRect(0, 0, BOARD_PX, BOARD_PX);
  drawWood(ctx);

  // 网格
  ctx.strokeStyle = 'rgba(70, 40, 10, 0.7)';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const p = gridXY(i);
    ctx.beginPath(); ctx.moveTo(gridXY(0), p); ctx.lineTo(gridXY(SIZE - 1), p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, gridXY(0)); ctx.lineTo(p, gridXY(SIZE - 1)); ctx.stroke();
  }
  // 外框加粗
  ctx.lineWidth = 2.2;
  ctx.strokeRect(gridXY(0), gridXY(0), CELL * (SIZE - 1), CELL * (SIZE - 1));

  // 星位
  ctx.fillStyle = 'rgba(60, 35, 8, 0.85)';
  for (const [sx, sy] of [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]]) {
    ctx.beginPath();
    ctx.arc(gridXY(sx), gridXY(sy), CELL * 0.11, 0, Math.PI * 2);
    ctx.fill();
  }

  // 坐标
  ctx.fillStyle = 'rgba(90, 55, 15, 0.65)';
  ctx.font = `${Math.max(9, CELL * 0.28)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String.fromCharCode(65 + i), gridXY(i), PAD * 0.42);
    ctx.fillText(String(i + 1), PAD * 0.4, gridXY(i));
  }

  // 棋子
  const winSet = new Set((state.winLine || []).map(c => c.x + ',' + c.y));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const c = state.board[y] && state.board[y][x];
      if (!c) continue;
      const isLast = state.lastMove && state.lastMove.x === x && state.lastMove.y === y;
      const inWin = winSet.has(x + ',' + y);
      const scale = isLast ? 0.6 + 0.4 * easeOutBack(ui.animT) : 1;
      const dim = state.winLine && !inWin;
      drawStone(ctx, x, y, c, scale, dim ? 0.35 : 1, inWin);
    }
  }

  // 悬停预览
  if (ui.hoverCell && canPlay() && state.board[ui.hoverCell.y][ui.hoverCell.x] === 0) {
    drawStone(ctx, ui.hoverCell.x, ui.hoverCell.y, state.color, 1, 0.45, false, true);
  }
}

function easeOutBack(t) {
  const c1 = 2.2, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function drawStone(ctx, x, y, color, scale = 1, alpha = 1, glow = false, ghost = false) {
  const cx = gridXY(x), cy = gridXY(y);
  const r = CELL * 0.44 * scale;
  ctx.save();
  ctx.globalAlpha = alpha;

  if (glow) {
    ctx.shadowColor = 'rgba(255, 210, 110, 0.95)';
    ctx.shadowBlur = CELL * 0.55;
  }

  // 阴影
  if (!ghost) {
    ctx.shadowColor = 'rgba(30, 15, 0, 0.4)';
    ctx.shadowBlur = CELL * 0.14;
    ctx.shadowOffsetY = CELL * 0.06;
  }
  // 棋子主体
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  if (color === 1) {
    g.addColorStop(0, '#6b7382');
    g.addColorStop(0.55, '#23272e');
    g.addColorStop(1, '#05060a');
  } else {
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.6, '#e8eaee');
    g.addColorStop(1, '#b3b9c2');
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // 高光
  const hl = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, 0, cx - r * 0.38, cy - r * 0.42, r * 0.5);
  hl.addColorStop(0, color === 1 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.85)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.arc(cx - r * 0.2, cy - r * 0.25, r * 0.55, 0, Math.PI * 2);
  ctx.fill();

  // 胜利描金
  if (glow) {
    ctx.strokeStyle = 'rgba(255, 215, 120, 0.95)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 最后一手标记
  const isLast = state.lastMove && state.lastMove.x === x && state.lastMove.y === y && !ghost;
  if (isLast && ui.animT >= 1) {
    ctx.fillStyle = color === 1 ? '#f0b545' : '#c0563f';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function animLoop(ts) {
  ui.animT = Math.min(1, ui.animT + 0.09);
  drawBoard();
  if (ui.animT < 1) {
    requestAnimationFrame(animLoop);
  } else {
    ui.animating = false;
  }
}

function canPlay() {
  return state.started && !state.gameOver && state.turn === state.color;
}

/* ============ 棋盘交互 ============ */
function eventToCell(e) {
  const rect = ui.canvas.getBoundingClientRect();
  const px = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const py = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  const x = Math.round((px - PAD) / CELL);
  const y = Math.round((py - PAD) / CELL);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
  // 距交叉点太远则忽略
  const dx = px - gridXY(x), dy = py - gridXY(y);
  if (dx * dx + dy * dy > CELL * CELL * 0.45) return null;
  return { x, y };
}

ui.canvas.addEventListener('mousemove', (e) => {
  if (!canPlay()) { ui.hoverCell = null; return; }
  const cell = eventToCell(e);
  const changed = JSON.stringify(cell) !== JSON.stringify(ui.hoverCell);
  ui.hoverCell = cell;
  if (changed) drawBoard();
  ui.canvas.style.cursor = cell && state.board[cell.y][cell.x] === 0 ? 'pointer' : 'default';
});
ui.canvas.addEventListener('mouseleave', () => { ui.hoverCell = null; drawBoard(); });

ui.canvas.addEventListener('click', (e) => {
  if (!canPlay()) {
    if (state.started && !state.gameOver && state.turn !== state.color) toast('还没轮到你落子哦');
    return;
  }
  const cell = eventToCell(e);
  if (!cell) return;
  if (state.board[cell.y][cell.x] !== 0) { toast('这里已经有棋子了'); return; }
  ui.hoverCell = null;
  send({ type: 'move', x: cell.x, y: cell.y });
});

/* ============ 各按钮事件 ============ */
function requireName() {
  const name = $('input-name').value.trim();
  if (!name) { toast('请先输入昵称'); $('input-name').focus(); return null; }
  localStorage.setItem('gomoku_name', name);
  state.name = name;
  return name;
}

$('btn-create').addEventListener('click', () => {
  const name = requireName();
  if (!name) return;
  if (!state.connected) { toast('正在连接服务器,请稍候再试'); return; }
  send({ type: 'create', name });
});
$('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });

$('btn-join').addEventListener('click', () => {
  const name = requireName();
  if (!name) return;
  const room = $('input-room').value.trim().toUpperCase();
  if (room.length !== 4) { toast('请输入 4 位房间码'); return; }
  if (!state.connected) { toast('正在连接服务器,请稍候再试'); return; }
  send({ type: 'join', name, room });
});
$('input-room').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
$('input-room').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});

$('btn-lobby-back').addEventListener('click', () => {
  // 关闭 ws 重新连接,服务器会清理空房间
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  state.room = '';
  connect();
  showScreen('home');
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制:' + text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
    toast('已复制:' + text);
  }
}
$('btn-copy-code').addEventListener('click', () => copyText(state.room));
$('btn-copy-link').addEventListener('click', () => copyText(`${location.origin}/?room=${state.room}`));
$('room-chip').addEventListener('click', () => copyText(state.room));

$('btn-sound').addEventListener('click', () => {
  ui.soundOn = !ui.soundOn;
  localStorage.setItem('gomoku_sound', ui.soundOn ? '1' : '0');
  $('btn-sound').textContent = ui.soundOn ? '🔊' : '🔇';
  toast(ui.soundOn ? '音效已开启' : '音效已关闭');
});

$('btn-undo').addEventListener('click', () => {
  if (!state.started || state.gameOver) return toast('当前无法悔棋');
  if (state.board.flat().every(v => !v)) return toast('还没有落子,无法悔棋');
  send({ type: 'undo_request' });
  toast('已发送悔棋请求,等待对方回应…');
});

$('btn-resign').addEventListener('click', () => {
  if (!state.started || state.gameOver) return;
  showModal({
    icon: '🏳️', title: '认输确认',
    desc: '确定要投子认输吗?<br>本局将判对手获胜',
    actions: [
      { text: '确认认输', cls: 'btn-danger', onClick: () => send({ type: 'resign' }) },
      { text: '继续对局', cls: 'btn-ghost' },
    ],
  });
});

function requestRestart() {
  if (state.restartClicked) return;
  state.restartClicked = true;
  send({ type: 'restart' });
  const btn = $('btn-restart');
  btn.disabled = true;
  btn.textContent = '⏳ 等待对方…';
}
$('btn-restart').addEventListener('click', requestRestart);

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send({ type: 'chat', text });
});
for (const q of QUICK_CHAT) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = q;
  b.addEventListener('click', () => send({ type: 'chat', text: q }));
  $('chat-quick').appendChild(b);
}

window.addEventListener('resize', () => { if (ui.screen === 'game') resizeCanvas(); });

/* ============ 启动 ============ */
(function init() {
  state.board = emptyBoard();
  $('input-name').value = state.name;
  $('btn-sound').textContent = ui.soundOn ? '🔊' : '🔇';
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    $('input-room').value = params.get('room').toUpperCase().slice(0, 4);
    $('input-name').focus();
  }
  showScreen('home');
  connect();
})();
