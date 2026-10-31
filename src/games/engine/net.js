/*
 * Transport for the phone-controller rooms.
 *
 * In `npm run dev` the big screen and phones talk through the WebSocket relay
 * mounted on Vite's server (server/rooms.js). Static hosts like Vercel can't
 * run that relay, so deployed builds connect phones straight to the big
 * screen over WebRTC instead, using the public PeerJS server only to make the
 * introduction. Both transports hand back a WebSocket-shaped object that
 * speaks the same JSON messages, so room.js and Controller.jsx don't care
 * which one they got.
 *
 * Override with VITE_PV_TRANSPORT=relay|p2p.
 */

const TRANSPORT = import.meta.env.VITE_PV_TRANSPORT ?? (import.meta.env.DEV ? 'relay' : 'p2p');

const PREFIX = 'playverse-v1-'; // PeerJS ids are global, so namespace ours
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PHONES = 8;
const CONN_OPTS = { serialization: 'json', reliable: true };

const newCode = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const loadPeer = () => import('peerjs').then((m) => m.Peer ?? m.default);

// Minimal WebSocket look-alike: readyState, send(string), close(), onopen/onmessage/onclose.
class Pipe {
  constructor() {
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
  }

  opened() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.();
  }

  emit(msg) {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) });
  }

  closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

/*
 * Big screen: plays the part of the relay server locally. It registers the
 * room code as its peer id and phones dial that id directly.
 */
class HostPipe extends Pipe {
  constructor() {
    super();
    this.peer = null;
    this.phones = new Map(); // id -> DataConnection
    this.nextId = 1;
    setTimeout(() => this.opened(), 0);
  }

  send(raw) {
    const m = JSON.parse(raw);
    if (m.t === 'host') this.open(typeof m.code === 'string' ? m.code : newCode());
    else if (m.t === 'to') this.phones.get(String(m.id))?.send(m.msg);
  }

  async open(code) {
    const Peer = await loadPeer();
    if (this.readyState === 3) return;
    const peer = new Peer(PREFIX + code);
    this.peer = peer;
    peer.on('open', () => this.emit({ t: 'room', code, ips: [] }));
    peer.on('connection', (conn) => this.accept(conn, code));
    // Lost the PeerJS server: phones already connected keep working, so just re-register.
    peer.on('disconnected', () => !peer.destroyed && peer.reconnect());
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        peer.destroy();
        this.open(newCode()); // someone else holds this code
      } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(err.type)) {
        this.close();
      }
    });
  }

  accept(conn, code) {
    let id = null;
    conn.on('data', (m) => {
      if (m?.t === 'join' && !id) {
        if (this.phones.size >= MAX_PHONES) {
          conn.send({ t: 'error', msg: 'This room is full.' });
          return;
        }
        id = String(this.nextId++);
        const name = String(m.name ?? '').trim().slice(0, 14) || `Player ${id}`;
        this.phones.set(id, conn);
        conn.send({ t: 'joined', id, code, hostOnline: true });
        this.emit({ t: 'player-join', id, name });
      } else if (m?.t === 'in' && id) {
        const axis = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
        this.emit({ t: 'in', id, x: axis(m.x), y: axis(m.y), a: !!m.a, b: !!m.b });
      }
    });
    conn.on('close', () => {
      if (!id || this.phones.get(id) !== conn) return;
      this.phones.delete(id);
      this.emit({ t: 'player-leave', id });
    });
  }

  close() {
    for (const conn of this.phones.values()) conn.close();
    this.phones.clear();
    this.peer?.destroy();
    this.closed();
  }
}

// Phone: dials the big screen's peer id once it knows the room code.
class PhonePipe extends Pipe {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    loadPeer().then((Peer) => {
      if (this.readyState === 3) return;
      const peer = new Peer();
      this.peer = peer;
      peer.on('open', () => this.opened());
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') this.emit({ t: 'error', msg: 'Room not found — check the code on the big screen.' });
        else this.close();
      });
    });
  }

  send(raw) {
    const m = JSON.parse(raw);
    if (m.t === 'join') {
      const conn = this.peer.connect(PREFIX + String(m.code).toUpperCase(), CONN_OPTS);
      this.conn = conn;
      conn.on('open', () => conn.send(m));
      conn.on('data', (msg) => this.emit(msg));
      conn.on('close', () => this.close());
    } else if (this.conn?.open) {
      this.conn.send(m);
    }
  }

  close() {
    this.conn?.close();
    this.peer?.destroy();
    this.closed();
  }
}

export function openRoomSocket(role) {
  if (TRANSPORT === 'p2p') return role === 'host' ? new HostPipe() : new PhonePipe();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(`${proto}://${location.host}/pv-ws`);
}
