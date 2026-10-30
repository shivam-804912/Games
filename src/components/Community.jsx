import { useId } from 'react';
import { ArrowRight, Users } from 'lucide-react';
import GameArt from './GameArt.jsx';
import { communityStats } from '../data.js';
import { svgId } from '../utils/random.js';

const SILHOUETTE = '#0a0718';

// Friends on a couch, seen from behind, lit by the TV.
const people = [
  { x: 120, r: 24, hair: 'bun' },
  { x: 238, r: 26, hair: 'spiky', raise: 1 },
  { x: 362, r: 25, hair: 'short' },
  { x: 480, r: 23, hair: 'pony', raise: -1 },
];

function Person({ x, r, hair, raise }) {
  const headY = 96;
  return (
    <g>
      {raise && (
        <>
          <path
            d={`M${x + raise * 32} 162 L${x + raise * 64} 112`}
            stroke={SILHOUETTE}
            strokeWidth="15"
            strokeLinecap="round"
          />
          <rect x={x + raise * 64 - 10} y="76" width="20" height="34" rx="4" />
        </>
      )}
      <path d={`M${x - 50} 220 Q${x - 52} 150 ${x - 22} 142 L${x + 22} 142 Q${x + 52} 150 ${x + 50} 220Z`} />
      <rect x={x - 10} y={headY + r - 8} width="20" height="30" />
      <circle cx={x} cy={headY} r={r} />
      {hair === 'bun' && <circle cx={x} cy={headY - r - 4} r="11" />}
      {hair === 'spiky' && (
        <path
          d={`M${x - r} ${headY - 8} L${x - r + 6} ${headY - r - 12} L${x - 6} ${headY - r + 2} L${x + 2} ${headY - r - 14} L${x + 10} ${headY - r + 2} L${x + r - 4} ${headY - r - 8} L${x + r} ${headY - 8}Z`}
        />
      )}
      {hair === 'pony' && (
        <path
          d={`M${x + r - 6} ${headY - 8} Q${x + r + 18} ${headY + 8} ${x + r + 6} ${headY + 36}`}
          fill="none"
          stroke={SILHOUETTE}
          strokeWidth="10"
          strokeLinecap="round"
        />
      )}
    </g>
  );
}

function PartyScene() {
  const id = `party${svgId(useId())}`;
  return (
    <div className="party" aria-hidden="true">
      <div className="party-screen">
        <GameArt variant="space" seed={14} width={480} height={270} />
      </div>
      <svg className="party-people" viewBox="0 0 600 220" preserveAspectRatio="xMidYMax meet">
        <defs>
          <linearGradient id={`${id}-couch`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3a2470" />
            <stop offset="1" stopColor="#140c33" />
          </linearGradient>
          <filter id={`${id}-rim`} x="-20%" y="-20%" width="140%" height="140%">
            <feMorphology in="SourceAlpha" operator="dilate" radius="1.6" result="d" />
            <feFlood floodColor="#a78bfa" />
            <feComposite in2="d" operator="in" result="o" />
            <feGaussianBlur in="o" stdDeviation="1.6" result="ob" />
            <feMerge>
              <feMergeNode in="ob" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id={`${id}-blur`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="10" />
          </filter>
        </defs>
        <g filter={`url(#${id}-blur)`}>
          <circle cx={238 + 64} cy="92" r="26" fill="#38d9ff" opacity=".55" />
          <circle cx={480 - 64} cy="92" r="26" fill="#ff3fa4" opacity=".55" />
        </g>
        <g fill={SILHOUETTE} filter={`url(#${id}-rim)`}>
          {people.map((p) => (
            <Person key={p.x} {...p} />
          ))}
        </g>
        <path d="M10 220 L10 194 Q10 180 26 180 L574 180 Q590 180 590 194 L590 220Z" fill={`url(#${id}-couch)`} />
        <path d="M26 181 L574 181" stroke="#fff" strokeOpacity=".14" strokeWidth="2" />
        <g stroke="#0d0826" strokeWidth="2">
          <line x1="178" y1="186" x2="178" y2="220" />
          <line x1="300" y1="186" x2="300" y2="220" />
          <line x1="422" y1="186" x2="422" y2="220" />
        </g>
        <rect x="0" y="166" width="54" height="54" rx="14" fill="#2c1b5c" />
        <rect x="546" y="166" width="54" height="54" rx="14" fill="#2c1b5c" />
      </svg>
      <span className="bubble bubble-play">Play</span>
      <span className="bubble bubble-compete">Compete</span>
      <span className="bubble bubble-friends">Make Friends</span>
    </div>
  );
}

export default function Community() {
  return (
    <section id="community" className="community">
      <div className="container community-grid">
        <div className="community-copy">
          <h2 className="section-title upper with-icon">
            <Users className="title-icon" size={26} /> Join Our Community
          </h2>
          <p>Play with friends, join tournaments, share your moments and be part of a growing gaming community.</p>
          <ul className="community-stats">
            {communityStats.map(({ icon: Icon, value, label }) => (
              <li key={label}>
                <span className="ic">
                  <Icon size={22} />
                </span>
                <div>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </div>
              </li>
            ))}
          </ul>
          <a href="#" className="btn btn-primary">
            Join Now <ArrowRight size={16} />
          </a>
        </div>
        <PartyScene />
      </div>
    </section>
  );
}
