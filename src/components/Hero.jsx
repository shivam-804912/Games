import { ArrowRight, Gamepad2, Play } from 'lucide-react';
import SplitScreen from './SplitScreen.jsx';
import PhoneController from './PhoneController.jsx';
import { heroStats } from '../data.js';

export default function Hero() {
  return (
    <section id="home" className="hero">
      <div className="container hero-grid">
        <div className="hero-copy">
          <span className="badge">
            <Gamepad2 size={14} /> Multiplayer Gaming Platform
          </span>
          <h1 className="hero-title">
            <span>One Screen</span>
            <span>Many Players</span>
            <span className="gradient-text">Endless Fun</span>
          </h1>
          <p className="hero-lead">
            Connect your phones, play together on a single screen, and enjoy 5 unique multiplayer games. Compete,
            explore, fight, race and more — all in one place.
          </p>
          <div className="hero-actions">
            <a href="#games" className="btn btn-primary btn-lg">
              Start Playing Free <ArrowRight size={18} />
            </a>
            <a href="#how-it-works" className="btn btn-outline btn-lg">
              <span className="play-dot">
                <Play size={10} fill="currentColor" />
              </span>
              Watch Video
            </a>
          </div>
          <ul className="hero-stats">
            {heroStats.map(({ icon: Icon, value, label }) => (
              <li key={label}>
                <Icon className="stat-icon" size={22} />
                <div>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="hero-glow" />
          <div className="tv">
            <div className="tv-frame">
              <SplitScreen hud />
            </div>
            <div className="tv-stand" />
          </div>
          <div className="hero-phones">
            <PhoneController tone="blue" />
            <PhoneController tone="red" />
          </div>
          <p className="hero-note">
            Your Phone Becomes the Controller!
            <svg viewBox="0 0 60 70" className="hero-note-arrow">
              <path d="M48 4 C56 30 40 52 12 60" />
              <path d="M12 60 L22 51 M12 60 L24 65" />
            </svg>
          </p>
        </div>
      </div>
    </section>
  );
}
