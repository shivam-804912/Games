import os from 'node:os';
import { WebSocketServer } from 'ws';

/*
 * Tiny WebSocket relay that lets phones act as controllers.
 *
 * The big screen ("host") opens a room and gets a 4-letter code. Phones join
 * with that code; their stick/button state is forwarded to the host, and the
 * host can send small messages back (player colour, vibration).
 * It is mounted on Vite's own HTTP server at /pv-ws, so `npm run dev`
 * serves the site, the games and the relay together.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PHONES = 8;
const HOST_GRACE_MS = 30_000;

const privateScore = (ip) =>
  ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0;

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map((a) => a.address)
    .sort((a, b) => privateScore(b) - privateScore(a));
}

const clampAxis = (v) => Math.max(-1, Math.min(1, Number(v) || 0));

function createRelay() {
  const rooms = new Map(); // code -> { host, phones: Map<id, { ws, name }>, timer }
  let nextId = 1;

  const send = (ws, msg) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  const newCode = () => {
    let code;
    do {
      code = Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    } while (rooms.has(code));
    return code;
  };

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    let role = null;
    let room = null;
    let code = null;
    let id = null;

    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }

      if (m.t === 'host' && !role) {
        // A host that reconnects (page reload, server restart) asks for its old code back.
        const wanted = typeof m.code === 'string' && /^[A-Z0-9]{4}$/.test(m.code) ? m.code : null;
        code = wanted && !rooms.get(wanted)?.host ? wanted : newCode();
        room = rooms.get(code) ?? { host: null, phones: new Map(), timer: null };
        clearTimeout(room.timer);
        room.host = ws;
        rooms.set(code, room);
        role = 'host';
        send(ws, { t: 'room', code, ips: lanAddresses() });
        for (const [pid, p] of room.phones) {
          send(ws, { t: 'player-join', id: pid, name: p.name });
          send(p.ws, { t: 'host-back' });
        }
        return;
      }

      if (m.t === 'join' && !role) {
        const wantedCode = String(m.code ?? '').trim().toUpperCase();
        const r = rooms.get(wantedCode);
        if (!r) return send(ws, { t: 'error', msg: 'Room not found — check the code on the big screen.' });
        if (r.phones.size >= MAX_PHONES) return send(ws, { t: 'error', msg: 'This room is full.' });
        role = 'phone';
        room = r;
        code = wantedCode;
        id = String(nextId++);
        const name = String(m.name ?? '').trim().slice(0, 14) || `Player ${id}`;
        r.phones.set(id, { ws, name });
        send(ws, { t: 'joined', id, code, hostOnline: !!r.host });
        send(r.host, { t: 'player-join', id, name });
        return;
      }

      if (m.t === 'in' && role === 'phone') {
        send(room.host, { t: 'in', id, x: clampAxis(m.x), y: clampAxis(m.y), a: !!m.a, b: !!m.b });
        return;
      }

      if (m.t === 'to' && role === 'host') {
        send(room.phones.get(String(m.id))?.ws, m.msg);
      }
    });

    ws.on('close', () => {
      if (role === 'phone') {
        room.phones.delete(id);
        send(room.host, { t: 'player-leave', id });
      } else if (role === 'host' && room.host === ws) {
        room.host = null;
        for (const p of room.phones.values()) send(p.ws, { t: 'host-left' });
        room.timer = setTimeout(() => {
          if (room.host) return;
          for (const p of room.phones.values()) p.ws.close();
          rooms.delete(code);
        }, HOST_GRACE_MS);
      }
    });
  });

  return (httpServer) => {
    httpServer?.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/pv-ws')) return; // leave Vite's HMR socket alone
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  };
}

export default function playverseRooms() {
  const attach = createRelay();
  return {
    name: 'playverse-rooms',
    configureServer(server) {
      attach(server.httpServer);
    },
    configurePreviewServer(server) {
      attach(server.httpServer);
    },
  };
}
