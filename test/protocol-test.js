/* 双客户端联机协议测试(内置简易 WebSocket 客户端,零依赖) */
const http = require('http');
const crypto = require('crypto');

function connect() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: 'localhost', port: process.env.PORT || 3000, path: '/',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => {
      const client = { socket, queue: [], waiters: [] };
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          if (buffer.length < 2) break;
          const opcode = buffer[0] & 0x0f;
          let len = buffer[1] & 0x7f, off = 2;
          if (len === 126) { if (buffer.length < 4) break; len = buffer.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buffer.length < 10) break; len = Number(buffer.readBigUInt64BE(2)); off = 10; }
          if (buffer.length < off + len) break;
          const payload = buffer.subarray(off, off + len);
          buffer = buffer.subarray(off + len);
          if (opcode === 0x1) {
            const msg = JSON.parse(payload.toString());
            const w = client.waiters.shift();
            w ? w(msg) : client.queue.push(msg);
          }
        }
      });
      client.send = (obj) => {
        const p = Buffer.from(JSON.stringify(obj));
        const mask = crypto.randomBytes(4);
        let header;
        if (p.length < 126) header = Buffer.from([0x81, 0x80 | p.length]);
        else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(p.length, 2); }
        const masked = Buffer.from(p);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        socket.write(Buffer.concat([header, mask, masked]));
      };
      client.next = (timeout = 3000) => new Promise((res2, rej2) => {
        const t = setTimeout(() => rej2(new Error('等待消息超时')), timeout);
        const done = (m) => { clearTimeout(t); res2(m); };
        client.queue.length ? done(client.queue.shift()) : client.waiters.push(done);
      });
      client.nextWhere = async (pred, timeout = 3000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          const msg = await client.next(Math.max(1, end - Date.now())).catch(() => null);
          if (!msg) break;
          if (pred(msg)) return msg;
        }
        throw new Error('未等到期望的消息');
      };
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}

const assert = (cond, label) => {
  if (cond) console.log('  ✓', label);
  else { console.error('  ✗', label); process.exit(1); }
};

(async () => {
  console.log('1) 连接两个客户端');
  const A = await connect();
  const B = await connect();
  assert(true, 'WebSocket 握手成功');

  console.log('2) A 创建房间');
  A.send({ type: 'create', name: 'Alice' });
  const joinedA = await A.nextWhere(m => m.type === 'joined');
  const created = await A.nextWhere(m => m.type === 'created');
  assert(created.type === 'created' && /^[A-Z0-9]{4}$/.test(created.room), `房间码 ${created.room}`);
  assert(joinedA.color === 1, 'A 执黑');

  console.log('3) B 加入房间');
  B.send({ type: 'join', name: 'Bob', room: created.room });
  const joinedB = await B.next();
  const startA = await A.next();
  const startB = await B.next();
  assert(joinedB.type === 'joined' && joinedB.color === 2, 'B 执白');
  assert(startA.type === 'start' && startB.type === 'start' && startA.black === 'Alice', '双方收到 start,Alice 执黑先行');

  console.log('4) 交替落子至黑方五连');
  // 黑(A)在第8行连5子,白(B)在第9行下4子
  const seq = [
    [7, 7, 'A'], [7, 8, 'B'],
    [8, 7, 'A'], [8, 8, 'B'],
    [9, 7, 'A'], [9, 8, 'B'],
    [10, 7, 'A'], [10, 8, 'B'],
    [11, 7, 'A'], // 黑方第五子,获胜
  ];
  for (const [x, y, who] of seq) {
    (who === 'A' ? A : B).send({ type: 'move', x, y });
    await A.nextWhere(m => m.type === 'move' || m.type === 'win');
    await B.nextWhere(m => m.type === 'move' || m.type === 'win');
  }
  const winA = await A.nextWhere(m => m.type === 'win');
  await B.nextWhere(m => m.type === 'win');
  assert(winA.color === 1 && winA.line.length >= 5, `黑方五连获胜,连线 ${winA.line.length} 子`);

  console.log('5) 对局结束后落子被拒绝');
  A.send({ type: 'move', x: 0, y: 0 });
  const noErr = await Promise.race([
    A.nextWhere(m => m.type === 'error', 800).catch(() => null),
    new Promise(r => setTimeout(() => r('silent'), 900)),
  ]);
  assert(noErr === 'silent', '结束后不响应落子');

  console.log('6) 聊天互通');
  A.send({ type: 'chat', text: '你好!' });
  const chatB = await B.nextWhere(m => m.type === 'chat');
  assert(chatB.text === '你好!' && chatB.from === 'Alice', 'B 收到 A 的消息');

  console.log('7) 再来一局(双方确认,交换黑白)');
  A.send({ type: 'restart' });
  await B.nextWhere(m => m.type === 'restart_request');
  B.send({ type: 'restart' });
  const s2 = await A.nextWhere(m => m.type === 'start');
  assert(s2.black === 'Bob', `重开成功,黑白互换:黑=${s2.black} 白=${s2.white}`);

  console.log('8) 悔棋流程');
  B.send({ type: 'move', x: 7, y: 7 }); // B 现在执黑先行
  await A.nextWhere(m => m.type === 'move');
  B.send({ type: 'undo_request' });
  const undoReq = await A.nextWhere(m => m.type === 'undo_request');
  assert(undoReq.from === 'Bob', 'A 收到悔棋请求');
  A.send({ type: 'undo_response', agree: true });
  const undoB = await B.nextWhere(m => m.type === 'undo');
  const undoA = await A.nextWhere(m => m.type === 'undo');
  assert(undoB.moves.length === 1 && undoB.turn === 1, '回退一手,轮到 B 重新落子');
  assert(undoA.moves.length === 1, 'A 同步悔棋结果');

  console.log('9) 认输判负');
  A.send({ type: 'resign' });
  const resignB = await B.nextWhere(m => m.type === 'resign');
  assert(resignB.winner === 'Bob' && resignB.loser === 'Alice', 'B 收到 A 认输');

  console.log('10) 断线通知');
  A.socket.destroy();
  const left = await B.nextWhere(m => m.type === 'opponent_left');
  assert(!!left, 'B 收到对手离线通知');

  console.log('\n全部协议测试通过');
  process.exit(0);
})().catch((e) => { console.error('测试失败:', e.message); process.exit(1); });
