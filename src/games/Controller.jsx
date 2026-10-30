import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, LogOut, RotateCw, WifiOff } from 'lucide-react';
import { LogoMark } from '../components/Logo.jsx';
import './games.css';

/*
 * Phone controller: join a room by code, then send stick + A/B state to the
 * big screen over the /pv-ws relay.
 */

const STICK_RADIUS = 60;
const DEAD_ZONE = 0.12;

const readParams = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
const capture = (el, id) => {
  try {
    el.setPointerCapture(id);
  } catch {
    /* pointer already gone */
  }
};
const loadName = () => {
  try {
    return localStorage.getItem('pv-name') ?? '';
  } catch {
    return '';
  }
};
const round2 = (v) => Math.round(v * 100) / 100;

function Joystick({ onMove }) {
  const areaRef = useRef(null);
  const origin = useRef(null);
  const pointer = useRef(null);
  const [stick, setStick] = useState(null);

  const local = (e) => {
    const r = areaRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e) => {
    if (pointer.current !== null) return;
    pointer.current = e.pointerId;
    capture(areaRef.current, e.pointerId);
    origin.current = local(e);
    setStick({ ...origin.current, dx: 0, dy: 0 });
    onMove(0, 0);
  };

  const move = (e) => {
    if (e.pointerId !== pointer.current) return;
    const p = local(e);
    let dx = p.x - origin.current.x;
    let dy = p.y - origin.current.y;
    const m = Math.hypot(dx, dy);
    if (m > STICK_RADIUS) {
      dx = (dx / m) * STICK_RADIUS;
      dy = (dy / m) * STICK_RADIUS;
    }
    const nx = dx / STICK_RADIUS;
    const ny = dy / STICK_RADIUS;
    const dead = Math.hypot(nx, ny) < DEAD_ZONE;
    onMove(dead ? 0 : nx, dead ? 0 : ny);
    setStick({ ...origin.current, dx, dy });
  };

  const up = (e) => {
    if (e.pointerId !== pointer.current) return;
    pointer.current = null;
    setStick(null);
    onMove(0, 0);
  };

  return (
    <div ref={areaRef} className="stick-area" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {stick ? (
        <>
          <span className="stick-base" style={{ left: stick.x, top: stick.y }} />
          <span className="stick-knob" style={{ left: stick.x + stick.dx, top: stick.y + stick.dy }} />
        </>
      ) : (
        <>
          <span className="stick-base idle" />
          <span className="stick-label">Move</span>
        </>
      )}
    </div>
  );
}

function PadButton({ label, sub, className, onChange }) {
  const [down, setDown] = useState(false);
  const set = (v) => {
    setDown(v);
    onChange(v);
  };
  return (
    <button
      type="button"
      className={`pad-btn ${className} ${down ? 'is-down' : ''}`}
      onPointerDown={(e) => {
        capture(e.currentTarget, e.pointerId);
        navigator.vibrate?.(8);
        set(true);
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => down && set(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
      {sub && <small>{sub}</small>}
    </button>
  );
}

export default function Controller() {
  const [code, setCode] = useState(() => (readParams().get('room') ?? '').toUpperCase());
  const [name, setName] = useState(loadName);
  const [status, setStatus] = useState('form'); // form | connecting | joined | reconnecting | error
  const [error, setError] = useState('');
  const [info, setInfo] = useState(null);
  const [hostAway, setHostAway] = useState(false);

  const wsRef = useRef(null);
  const wantJoin = useRef(false);
  const state = useRef({ x: 0, y: 0, a: false, b: false });
  const lastSent = useRef(0);
  const pending = useRef(false);

  const flush = useCallback(() => {
    pending.current = false;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    const s = state.current;
    ws.send(JSON.stringify({ t: 'in', x: round2(s.x), y: round2(s.y), a: s.a, b: s.b }));
    lastSent.current = performance.now();
  }, []);

  // Stick updates are throttled to ~30/s; button changes go out immediately.
  const setInput = useCallback(
    (patch, urgent = false) => {
      Object.assign(state.current, patch);
      if (urgent) return flush();
      if (pending.current) return undefined;
      pending.current = true;
      setTimeout(flush, Math.max(0, 33 - (performance.now() - lastSent.current)));
      return undefined;
    },
    [flush],
  );

  const connect = useCallback((roomCode, playerName) => {
    wsRef.current?.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/pv-ws`);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', code: roomCode, name: playerName }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'joined') {
        setStatus('joined');
        setHostAway(!m.hostOnline);
      } else if (m.t === 'error') {
        wantJoin.current = false;
        setError(m.msg);
        setStatus('error');
        ws.close();
      } else if (m.t === 'info') setInfo(m);
      else if (m.t === 'buzz') navigator.vibrate?.(m.ms ?? 60);
      else if (m.t === 'host-left') setHostAway(true);
      else if (m.t === 'host-back') setHostAway(false);
    };
    ws.onclose = () => {
      if (wsRef.current !== ws || !wantJoin.current) return;
      setStatus('reconnecting');
      setTimeout(() => wantJoin.current && connect(roomCode, playerName), 1500);
    };
  }, []);

  useEffect(() => {
    if (status !== 'joined') return undefined;
    const beat = setInterval(flush, 250);
    const onHide = () => {
      if (document.hidden) setInput({ x: 0, y: 0, a: false, b: false }, true);
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(beat);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [status, flush, setInput]);

  useEffect(
    () => () => {
      wantJoin.current = false;
      wsRef.current?.close();
    },
    [],
  );

  const join = (e) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length !== 4) {
      setError('Enter the 4-character room code shown on the big screen.');
      setStatus('error');
      return;
    }
    const n = name.trim() || 'Player';
    try {
      localStorage.setItem('pv-name', n);
    } catch {
      /* storage unavailable */
    }
    setError('');
    setInfo(null);
    wantJoin.current = true;
    setStatus('connecting');
    connect(c, n);
    // Best effort: full screen, landscape and keep the screen awake.
    document.documentElement.requestFullscreen?.().then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
    navigator.wakeLock?.request('screen').catch(() => {});
  };

  const leave = () => {
    wantJoin.current = false;
    wsRef.current?.close();
    setStatus('form');
    setInfo(null);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  };

  if (status === 'joined' || status === 'reconnecting') {
    const color = info?.color ?? '#8b6cff';
    const labels = info?.labels ?? { a: 'Action', b: 'Special' };
    const statusText =
      status === 'reconnecting'
        ? 'Reconnecting…'
        : hostAway
          ? 'Waiting for the big screen…'
          : !info
            ? 'Connected'
            : info.status === 'spectating'
              ? 'Game is full — you’ll join next round'
              : info.status === 'lobby'
                ? 'In the lobby — get ready!'
                : info.status === 'paused'
                  ? 'Paused'
                  : 'Playing';

    return (
      <div className="pad" style={{ '--c': color }}>
        <header className="pad-top">
          <span className="pad-player">
            <span className="pad-dot" />
            {info?.slot ? `P${info.slot} · ` : ''}
            {info?.name ?? name}
          </span>
          <span className="pad-status">
            {status === 'reconnecting' && <Loader2 size={14} className="spin" />}
            {info?.game ? `${info.game} — ` : ''}
            {statusText}
          </span>
          <button type="button" className="pad-leave" onClick={leave} aria-label="Leave room">
            <LogOut size={16} />
          </button>
        </header>
        <div className="pad-body">
          <Joystick onMove={(x, y) => setInput({ x, y })} />
          <div className="pad-buttons">
            <PadButton label="B" sub={labels.b} className="pad-b" onChange={(v) => setInput({ b: v }, true)} />
            <PadButton label="A" sub={labels.a} className="pad-a" onChange={(v) => setInput({ a: v }, true)} />
          </div>
        </div>
        <p className="pad-rotate">
          <RotateCw size={14} /> Turn your phone sideways for the best grip
        </p>
      </div>
    );
  }

  return (
    <div className="join-page">
      <form className="join-card" onSubmit={join}>
        <div className="join-logo">
          <LogoMark size={40} />
          <span>PlayVerse</span>
        </div>
        <h1>Join a game</h1>
        <p>Enter the room code shown on the big screen. Your phone becomes the controller.</p>
        <label>
          Room code
          <input
            className="join-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
            placeholder="ABCD"
            autoCapitalize="characters"
            autoComplete="off"
            inputMode="text"
          />
        </label>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 14))} placeholder="Player" autoComplete="nickname" />
        </label>
        {status === 'error' && (
          <p className="join-error">
            <WifiOff size={15} /> {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-lg" disabled={status === 'connecting'}>
          {status === 'connecting' ? <Loader2 size={18} className="spin" /> : null}
          {status === 'connecting' ? 'Joining…' : 'Join'}
        </button>
      </form>
    </div>
  );
}
