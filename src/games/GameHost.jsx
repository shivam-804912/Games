import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowLeft,
  Bot,
  DoorOpen,
  Gamepad2,
  Keyboard,
  Pause,
  Play,
  RotateCcw,
  Smartphone,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import GameArt from '../components/GameArt.jsx';
import { GAMES } from './registry.js';
import { input } from './engine/input.js';
import { getRoom, useRoom } from './engine/room.js';
import { sfx } from './engine/sfx.js';
import { H, PLAYER_COLORS, W } from './engine/util.js';
import './games.css';

const STEP = 1 / 60;
const KIND_ICON = { keyboard: Keyboard, gamepad: Gamepad2, phone: Smartphone, cpu: Bot };
const KIND_LABEL = { keyboard: 'Keyboard', gamepad: 'Gamepad', phone: 'Phone', cpu: 'CPU' };

const nextColor = (list) => PLAYER_COLORS.find((c) => !list.some((p) => p.color === c)) ?? PLAYER_COLORS[0];

function localPlayer(list, source) {
  const name = source === 'kb1' ? 'Keys 1' : source === 'kb2' ? 'Keys 2' : `Pad ${Number(source.slice(2)) + 1}`;
  return { id: source, source, kind: source.startsWith('kb') ? 'keyboard' : 'gamepad', name, color: nextColor(list) };
}

// Keep the roster in sync with phones connected to the room.
function syncPhones(list, phones, max) {
  let next = list.filter((p) => p.kind !== 'phone' || phones.has(p.id.slice(6)));
  for (const ph of phones.values()) {
    const id = `phone:${ph.id}`;
    if (next.some((p) => p.id === id)) continue;
    if (next.length >= max) {
      const cpu = next.findIndex((p) => p.kind === 'cpu');
      if (cpu === -1) continue;
      next = next.filter((_, i) => i !== cpu);
    }
    next = [...next, { id, source: id, kind: 'phone', name: ph.name, color: nextColor(next) }];
  }
  const same = next.length === list.length && next.every((p, i) => p === list[i]);
  return same ? list : next;
}

function buzzPlayer(p, ms) {
  if (!p) return;
  if (p.kind === 'phone') getRoom().send(p.id.slice(6), { t: 'buzz', ms });
  else if (p.kind === 'gamepad') input.rumble(p.source, ms);
}

/* ------------------------------------------------------------------ Lobby */

function JoinCard({ room }) {
  const [ipIndex, setIpIndex] = useState(0);
  const [qr, setQr] = useState(null);
  const ip = room.ips[ipIndex] ?? room.ips[0];
  const url = room.code ? room.joinUrl(ip) : null;
  const localOnly = url?.includes('localhost') || url?.includes('127.0.0.1');

  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#0b0a1a', light: '#ffffff' } }).then((d) => alive && setQr(d));
    return () => {
      alive = false;
    };
  }, [url]);

  return (
    <section className="lobby-panel lobby-join">
      <h2>
        <Smartphone size={18} /> Join with your phone
      </h2>
      <div className="qr-card">{qr && room.code ? <img src={qr} alt="QR code that opens the controller page" /> : <div className="qr-wait" />}</div>
      <div className="room-code" aria-label="Room code">
        {room.code ?? '····'}
      </div>
      <p className="join-url">{url ?? 'Opening a room…'}</p>
      <p className={`room-status ${room.status}`}>
        {room.status === 'online' ? <Wifi size={14} /> : <WifiOff size={14} />}
        {room.status === 'online'
          ? 'Scan the code or open the link on a phone on the same Wi-Fi.'
          : room.status === 'connecting'
            ? 'Connecting to the room server…'
            : 'Room server offline — phones can’t join right now.'}
      </p>
      {localOnly && room.status === 'online' && (
        <p className="room-warn">No network address found — phones need this computer to be on Wi-Fi or LAN.</p>
      )}
      {room.ips.length > 1 && (
        <label className="ip-select">
          Network
          <select value={ipIndex} onChange={(e) => setIpIndex(Number(e.target.value))}>
            {room.ips.map((addr, i) => (
              <option key={addr} value={i}>
                {addr}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

function Lobby({ def, players, setPlayers, room, canStart, reason, onStart }) {
  const full = players.length >= def.maxPlayers;

  const addCpu = () =>
    setPlayers((list) => {
      if (list.length >= def.maxPlayers) return list;
      const n = list.filter((p) => p.kind === 'cpu').length + 1;
      return [...list, { id: `cpu-${Date.now()}-${n}`, source: null, kind: 'cpu', name: `CPU ${n}`, color: nextColor(list) }];
    });

  return (
    <div className="lobby">
      <div className="lobby-bg" aria-hidden="true">
        <GameArt variant={def.art} seed={7} width={1600} height={900} />
      </div>

      <div className="lobby-grid">
        <section className="lobby-panel lobby-info">
          <span className="chip chip-genre" style={{ '--accent': def.accent }}>
            {def.genre}
          </span>
          <h1>{def.title}</h1>
          <p className="lobby-tagline">{def.tagline}</p>
          <ul className="lobby-howto">
            {def.howTo.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="lobby-controls">
            <div>
              <span className="pad-key">Stick</span> {def.controls.move}
            </div>
            <div>
              <span className="pad-key key-a">A</span> {def.controls.a}
            </div>
            <div>
              <span className="pad-key key-b">B</span> {def.controls.b}
            </div>
          </div>
          <div className="lobby-keys">
            <div>
              <Keyboard size={15} /> <strong>Keyboard 1</strong> W A S D · <kbd>F</kbd> = A · <kbd>G</kbd> = B
            </div>
            <div>
              <Keyboard size={15} /> <strong>Keyboard 2</strong> Arrows · <kbd>K</kbd> = A · <kbd>L</kbd> = B
            </div>
            <div>
              <Gamepad2 size={15} /> <strong>Gamepad</strong> Left stick · A · B
            </div>
          </div>
        </section>

        <section className="lobby-panel lobby-players">
          <h2>
            <Users size={18} /> Players{' '}
            <span>
              {players.length}/{def.maxPlayers}
            </span>
          </h2>
          <div className={`slots ${def.maxPlayers > 4 ? 'slots-8' : ''}`}>
            {Array.from({ length: def.maxPlayers }, (_, i) => {
              const p = players[i];
              if (!p) {
                return (
                  <div key={`empty-${i}`} className="slot slot-empty">
                    <span className="slot-num">P{i + 1}</span>
                    Open slot
                  </div>
                );
              }
              const Icon = KIND_ICON[p.kind];
              return (
                <div key={p.id} className="slot" style={{ '--c': p.color }}>
                  <span className="slot-num">P{i + 1}</span>
                  <span className="slot-name">{p.name}</span>
                  <span className="slot-kind">
                    <Icon size={14} /> {KIND_LABEL[p.kind]}
                  </span>
                  <button
                    type="button"
                    className="slot-remove"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => setPlayers((list) => list.filter((x) => x.id !== p.id))}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          <p className="lobby-hint">
            Press <kbd>F</kbd> or <kbd>K</kbd> to join on the keyboard, <kbd>A</kbd> on a gamepad. Press B to leave.
          </p>
          <div className="lobby-actions">
            {def.cpu && (
              <button type="button" className="btn btn-outline" onClick={addCpu} disabled={full}>
                <Bot size={17} /> Add CPU
              </button>
            )}
            <button type="button" className="btn btn-primary btn-lg" onClick={onStart} disabled={!canStart}>
              <Play size={17} fill="currentColor" /> Start Game
            </button>
          </div>
          <p className="lobby-need">{canStart ? 'Ready! Press Enter or click Start.' : reason}</p>
        </section>

        <JoinCard room={room} />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Overlays */

function Results({ result, onAgain, onLobby }) {
  return (
    <div className="gh-overlay">
      <div className="gh-modal results">
        <span className="results-label">Game over</span>
        <h2 style={{ color: result.color ?? '#fff' }}>{result.title}</h2>
        {result.subtitle && <p className="results-sub">{result.subtitle}</p>}
        <table className="results-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              {result.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={`${row.name}-${i}`}>
                <td>{i + 1}</td>
                <td>
                  <span className="dot" style={{ background: row.color }} /> {row.name}
                </td>
                {row.values.map((v, j) => (
                  <td key={j}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="gh-modal-actions">
          <button type="button" className="btn btn-primary" onClick={onAgain}>
            <RotateCcw size={16} /> Play Again
          </button>
          <button type="button" className="btn btn-outline" onClick={onLobby}>
            <Users size={16} /> Lobby
          </button>
          <a href="#games" className="btn btn-outline">
            <DoorOpen size={16} /> Exit
          </a>
        </div>
      </div>
    </div>
  );
}

function PauseMenu({ onResume, onRestart, onLobby }) {
  return (
    <div className="gh-overlay">
      <div className="gh-modal">
        <h2>Paused</h2>
        <div className="gh-modal-actions column">
          <button type="button" className="btn btn-primary" onClick={onResume}>
            <Play size={16} fill="currentColor" /> Resume
          </button>
          <button type="button" className="btn btn-outline" onClick={onRestart}>
            <RotateCcw size={16} /> Restart
          </button>
          <button type="button" className="btn btn-outline" onClick={onLobby}>
            <Users size={16} /> Back to lobby
          </button>
          <a href="#games" className="btn btn-outline">
            <DoorOpen size={16} /> Exit to PlayVerse
          </a>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Host */

export default function GameHost({ gameId }) {
  const def = GAMES[gameId];
  const room = useRoom();
  const [phase, setPhase] = useState('lobby');
  const [players, setPlayers] = useState([]);
  const [session, setSession] = useState(0);
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState(null);
  const [muted, setMuted] = useState(sfx.muted);
  const canvasRef = useRef(null);
  const pausedRef = useRef(false);
  const playersRef = useRef(players);
  playersRef.current = players;
  pausedRef.current = paused;

  const humans = players.filter((p) => p.kind !== 'cpu').length;
  const canStart = !!def && players.length >= def.minPlayers && humans > 0;
  const reason = !def
    ? ''
    : humans === 0
      ? 'Join with a keyboard, gamepad or phone to start.'
      : `Needs at least ${def.minPlayers} players${def.cpu ? ' — add a CPU to fill in.' : '.'}`;

  const start = () => {
    if (!canStart) return;
    sfx.unlock();
    setResult(null);
    setPaused(false);
    setPhase('playing');
    setSession((s) => s + 1);
  };
  const startRef = useRef(start);
  startRef.current = start;

  const toLobby = () => {
    setResult(null);
    setPaused(false);
    setPhase('lobby');
  };

  useEffect(() => {
    input.capture = true;
    document.body.classList.add('is-game');
    return () => {
      input.capture = false;
      document.body.classList.remove('is-game');
    };
  }, []);

  // Phones joining/leaving the room fill the roster while in the lobby.
  useEffect(() => {
    if (phase !== 'lobby' || !def) return;
    setPlayers((list) => syncPhones(list, room.phones, def.maxPlayers));
  }, [phase, room.version, def]);

  // Tell each phone what it controls.
  useEffect(() => {
    if (!def) return;
    for (const ph of room.phones.values()) {
      const idx = players.findIndex((p) => p.id === `phone:${ph.id}`);
      const p = players[idx];
      room.send(ph.id, {
        t: 'info',
        game: def.title,
        name: ph.name,
        color: p?.color ?? '#7b77a3',
        slot: p ? idx + 1 : null,
        status: !p ? 'spectating' : phase === 'lobby' ? 'lobby' : paused ? 'paused' : 'playing',
        labels: def.controls,
      });
    }
  }, [room, room.version, players, phase, paused, def]);

  // Lobby: local players join with A and leave with B.
  useEffect(() => {
    if (phase !== 'lobby' || !def) return undefined;
    let raf;
    let prev = null;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const sources = ['kb1', 'kb2', ...input.gamepadSources()];
      const now = Object.fromEntries(sources.map((s) => [s, input.read(s)]));
      if (prev) {
        for (const s of sources) {
          const was = prev[s] ?? { a: true, b: true };
          if (now[s].a && !was.a) {
            setPlayers((list) => (list.some((p) => p.id === s) || list.length >= def.maxPlayers ? list : [...list, localPlayer(list, s)]));
          }
          if (now[s].b && !was.b) setPlayers((list) => list.filter((p) => p.id !== s));
        }
      }
      prev = now;
    };
    tick();
    const onKey = (e) => {
      if (e.code === 'Enter') startRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [phase, def]);

  // Esc / P toggles pause.
  useEffect(() => {
    if (phase !== 'playing') return undefined;
    const onKey = (e) => {
      if ((e.code === 'Escape' || e.code === 'KeyP') && !result) setPaused((p) => !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, result]);

  // The game loop: fixed 60 Hz simulation, render every frame.
  useEffect(() => {
    if (phase !== 'playing' || !def) return undefined;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const roster = playersRef.current;
    const game = def.create({
      players: roster.map(({ name, color, kind }) => ({ name, color, cpu: kind === 'cpu' })),
      host: {
        sfx: (name) => sfx.play(name),
        buzz: (i, ms = 80) => buzzPlayer(roster[i], ms),
      },
    });
    if (import.meta.env.DEV) window.__game = game; // handy for debugging in the console
    const prev = roster.map(() => ({ a: true, b: true }));
    let raf;
    let last = performance.now();
    let acc = 0;
    let reported = false;
    let resultTimer;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const pw = Math.round(cw * dpr);
      const ph = Math.round(ch * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const scale = Math.min(cw / W, ch / H);
      const ox = (cw - W * scale) / 2;
      const oy = (ch - H * scale) / 2;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05040d';
      ctx.fillRect(0, 0, pw, ph);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
      game.render(ctx);
      ctx.restore();
    };

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!pausedRef.current) {
        acc += dt;
        let steps = 0;
        while (acc >= STEP && steps < 5) {
          const inputs = roster.map((p, i) => {
            if (p.kind === 'cpu') return null;
            const s = input.read(p.source);
            const r = { x: s.x, y: s.y, a: s.a, b: s.b, aPressed: s.a && !prev[i].a, bPressed: s.b && !prev[i].b };
            prev[i] = { a: s.a, b: s.b };
            return r;
          });
          game.update(STEP, inputs);
          acc -= STEP;
          steps++;
        }
        if (steps === 5) acc = 0;
      }
      draw();
      if (game.result && !reported) {
        reported = true;
        resultTimer = setTimeout(() => setResult(game.result), 1400);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resultTimer);
      game.dispose?.();
    };
  }, [phase, session, def]);

  if (!def) {
    return (
      <div className="gh-missing">
        <h1>Game not found</h1>
        <a href="#games" className="btn btn-primary">
          <ArrowLeft size={16} /> Back to PlayVerse
        </a>
      </div>
    );
  }

  const toggleMute = () => {
    sfx.setMuted(!muted);
    setMuted(!muted);
  };

  return (
    <div className="gh">
      {phase === 'playing' && <canvas ref={canvasRef} className="gh-canvas" />}

      {phase === 'lobby' && (
        <Lobby def={def} players={players} setPlayers={setPlayers} room={room} canStart={canStart} reason={reason} onStart={start} />
      )}

      <div className="gh-bar">
        {phase === 'lobby' ? (
          <a href="#games" className="gh-chip">
            <ArrowLeft size={16} /> PlayVerse
          </a>
        ) : (
          <button type="button" className="gh-chip" onClick={() => setPaused(true)} aria-label="Pause">
            <Pause size={16} /> Pause
          </button>
        )}
        <div className="gh-bar-right">
          {room.code && (
            <span className="gh-chip gh-room" title="Room code for phones">
              <Smartphone size={15} /> {room.code}
            </span>
          )}
          <button type="button" className="gh-chip" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </div>
      </div>

      {paused && !result && (
        <PauseMenu
          onResume={() => setPaused(false)}
          onRestart={() => {
            setPaused(false);
            setSession((s) => s + 1);
          }}
          onLobby={toLobby}
        />
      )}

      {result && (
        <Results
          result={result}
          onAgain={() => {
            setResult(null);
            setSession((s) => s + 1);
          }}
          onLobby={toLobby}
        />
      )}
    </div>
  );
}
