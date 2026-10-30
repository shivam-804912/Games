import { getRoom } from './room.js';

/*
 * Every player is read through the same shape: { x, y, a, b }
 * with x/y in -1..1. Sources: two keyboard layouts, gamepads, phones.
 */

const LAYOUTS = {
  kb1: { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], a: ['KeyF', 'Space'], b: ['KeyG'] },
  kb2: { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], a: ['KeyK'], b: ['KeyL'] },
};

export const KEY_HINTS = {
  kb1: { move: 'W A S D', a: 'F', b: 'G' },
  kb2: { move: 'Arrow keys', a: 'K', b: 'L' },
};

const GAME_KEYS = new Set(Object.values(LAYOUTS).flatMap((l) => Object.values(l).flat()));
const ZERO = Object.freeze({ x: 0, y: 0, a: false, b: false });

class InputHub {
  constructor() {
    this.keys = new Set();
    this.capture = false; // swallow arrow/space scrolling while a game page is open
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (this.capture && GAME_KEYS.has(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  any(codes) {
    return codes.some((c) => this.keys.has(c));
  }

  read(source) {
    if (!source) return ZERO;
    const layout = LAYOUTS[source];
    if (layout) {
      let x = (this.any(layout.right) ? 1 : 0) - (this.any(layout.left) ? 1 : 0);
      let y = (this.any(layout.down) ? 1 : 0) - (this.any(layout.up) ? 1 : 0);
      if (x && y) {
        x *= Math.SQRT1_2;
        y *= Math.SQRT1_2;
      }
      return { x, y, a: this.any(layout.a), b: this.any(layout.b) };
    }
    if (source.startsWith('gp')) {
      const pad = navigator.getGamepads?.()[Number(source.slice(2))];
      if (!pad) return ZERO;
      const btn = (i) => !!pad.buttons[i]?.pressed;
      let x = pad.axes[0] ?? 0;
      let y = pad.axes[1] ?? 0;
      if (btn(14)) x = -1;
      if (btn(15)) x = 1;
      if (btn(12)) y = -1;
      if (btn(13)) y = 1;
      const m = Math.hypot(x, y);
      if (m < 0.18) x = y = 0;
      else if (m > 1) {
        x /= m;
        y /= m;
      }
      return { x, y, a: btn(0) || btn(2), b: btn(1) || btn(3) };
    }
    if (source.startsWith('phone:')) return getRoom().inputs.get(source.slice(6)) ?? ZERO;
    return ZERO;
  }

  gamepadSources() {
    return [...(navigator.getGamepads?.() ?? [])].filter(Boolean).map((p) => `gp${p.index}`);
  }

  rumble(source, ms) {
    const pad = navigator.getGamepads?.()[Number(source.slice(2))];
    pad?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: 0.6, weakMagnitude: 0.4 }).catch?.(() => {});
  }
}

export const input = new InputHub();
