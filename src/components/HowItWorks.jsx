import { ArrowRight } from 'lucide-react';
import GameArt from './GameArt.jsx';
import { LogoMark } from './Logo.jsx';
import PhoneController from './PhoneController.jsx';
import QrCode from './QrCode.jsx';
import SplitScreen from './SplitScreen.jsx';
import { steps } from '../data.js';

function MiniMonitor() {
  return (
    <div className="mini-monitor">
      <div className="mini-bar">
        <LogoMark size={14} />
        <span>PlayVerse</span>
        <i />
        <i />
      </div>
      <div className="mini-tiles">
        {['shooter', 'city', 'space'].map((art, i) => (
          <div key={art} className="mini-tile">
            <GameArt variant={art} seed={30 + i} width={160} height={210} />
          </div>
        ))}
      </div>
    </div>
  );
}

function JoinByCode() {
  return (
    <div className="qr-join">
      <div className="qr">
        <QrCode />
      </div>
      <div className="mini-phone">
        <span>Join Game</span>
        <strong>A7K3</strong>
        <em>Join</em>
      </div>
    </div>
  );
}

const visuals = [
  <MiniMonitor key="monitor" />,
  <JoinByCode key="join" />,
  <PhoneController key="phone" tone="blue" size="sm" />,
  <div key="split" className="step-split">
    <SplitScreen players={['P1', 'P3']} />
  </div>,
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="section">
      <div className="container">
        <span className="eyebrow">How It Works</span>
        <h2 className="section-title">
          Play Together in <span className="gradient-text">4 Simple Steps</span>
        </h2>
        <p className="section-sub">Turn any screen into a multiplayer gaming setup using just your phones.</p>

        <ol className="steps">
          {steps.map((step, i) => (
            <li key={step.title} className="card step-card">
              <div className="step-head">
                <span className="step-num">{i + 1}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </div>
              <div className="step-visual" aria-hidden="true">
                {visuals[i]}
              </div>
              {i < steps.length - 1 && <ArrowRight className="step-arrow" size={20} aria-hidden="true" />}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
