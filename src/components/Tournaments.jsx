import { useState } from 'react';
import { ArrowRight, Check, Trophy, Users } from 'lucide-react';
import { Cover } from './GameArt.jsx';
import { tournaments } from '../data.js';

function TournamentCard({ t, seed }) {
  const [registered, setRegistered] = useState(false);
  return (
    <article className="card tour-card">
      <div className="tour-thumb">
        <Cover image={t.image} art={t.art} title={t.title} seed={seed} width={320} height={200} />
        <span className="countdown">In {t.inDays} days</span>
      </div>
      <div className="tour-body">
        <h3>{t.title}</h3>
        <p>{t.format}</p>
        <div className="tour-meta">
          <span>
            <Users size={14} /> {t.players} Players
          </span>
          <span className="prize">
            <Trophy size={14} /> {t.prize}
          </span>
        </div>
        <button
          type="button"
          className={`btn btn-sm btn-block ${registered ? 'btn-done' : 'btn-primary'}`}
          onClick={() => setRegistered((v) => !v)}
          aria-pressed={registered}
        >
          {registered ? (
            <>
              <Check size={15} /> Registered
            </>
          ) : (
            'Register Now'
          )}
        </button>
      </div>
    </article>
  );
}

export default function Tournaments() {
  return (
    <section id="tournaments" className="section section-tight">
      <div className="container">
        <div className="section-head">
          <div>
            <h2 className="section-title upper with-icon">
              <Trophy className="title-icon" size={26} /> Upcoming Tournaments
            </h2>
            <p className="section-sub">Join exciting tournaments and win amazing rewards.</p>
          </div>
          <a href="#tournaments" className="link-pill">
            View All <ArrowRight size={16} />
          </a>
        </div>

        <div className="tour-grid">
          {tournaments.map((t, i) => (
            <TournamentCard key={t.id} t={t} seed={40 + i} />
          ))}
        </div>
      </div>
    </section>
  );
}
