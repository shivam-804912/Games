import { useSyncExternalStore } from 'react';

/*
 * Host side of the phone-controller relay (see server/rooms.js).
 * One room lives for the whole browser session, so phones stay connected
 * while the big screen moves between games.
 */

const listeners = new Set();

class HostRoom {
  constructor() {
    this.code = null;
    this.ips = [];
    this.status = 'connecting';
    this.phones = new Map(); // id -> { id, name }
    this.inputs = new Map(); // id -> { x, y, a, b }
    this.version = 0;
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/pv-ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'host', code: this.code }));
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      this.status = 'offline';
      this.phones.clear();
      this.inputs.clear();
      this.notify();
      setTimeout(() => this.connect(), 2000);
    };
  }

  onMessage(m) {
    switch (m.t) {
      case 'room':
        this.code = m.code;
        this.ips = m.ips ?? [];
        this.status = 'online';
        break;
      case 'player-join':
        this.phones.set(m.id, { id: m.id, name: m.name });
        break;
      case 'player-leave':
        this.phones.delete(m.id);
        this.inputs.delete(m.id);
        break;
      case 'in':
        this.inputs.set(m.id, { x: m.x, y: m.y, a: m.a, b: m.b });
        return; // high-frequency, no re-render
      default:
        return;
    }
    this.notify();
  }

  send(id, msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'to', id, msg }));
  }

  joinUrl(ip) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const host = local && ip ? `${ip}${location.port ? `:${location.port}` : ''}` : location.host;
    return `${location.protocol}//${host}/#/join?room=${this.code ?? ''}`;
  }

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  notify() {
    this.version++;
    listeners.forEach((fn) => fn());
  }
}

let room = null;
export const getRoom = () => (room ??= new HostRoom());

export function useRoom() {
  const r = getRoom();
  // Snapshot on version so an update that lands before we subscribe isn't missed.
  useSyncExternalStore(
    (fn) => r.subscribe(fn),
    () => r.version,
  );
  return r;
}
