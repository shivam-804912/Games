import { useId } from 'react';
import { svgId } from '../utils/random.js';

export function LogoMark({ size = 36 }) {
  const gid = `logo${svgId(useId())}`;
  return (
    <svg width={size} height={size * 0.68} viewBox="0 0 48 32" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff4fd8" />
          <stop offset="1" stopColor="#6c4bff" />
        </linearGradient>
      </defs>
      <path
        d="M12 2h24c7 0 11 7 11.5 15 .5 8-2.5 14-7.5 14-4 0-6-5-9-8H17c-3 3-5 8-9 8-5 0-8-6-7.5-14C1 9 5 2 12 2z"
        fill={`url(#${gid})`}
      />
      <rect x="10" y="12.5" width="10" height="3.5" rx="1" fill="#fff" />
      <rect x="13.25" y="9.25" width="3.5" height="10" rx="1" fill="#fff" />
      <circle cx="33" cy="11" r="2.3" fill="#fff" />
      <circle cx="38" cy="16" r="2.3" fill="#fff" />
    </svg>
  );
}

export default function Logo() {
  return (
    <a href="#home" className="logo" aria-label="PlayVerse home">
      <LogoMark />
      <span>PlayVerse</span>
    </a>
  );
}
