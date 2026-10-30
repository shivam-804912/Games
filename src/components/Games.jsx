import { ArrowRight, Users } from 'lucide-react';
import { Cover } from './GameArt.jsx';
import { games } from '../data.js';

export default function Games() {
  return (
    <section id="games" className="section">
      <div className="container">
        <div className="section-head">
          <div>
            <h2 className="section-title upper">Our Games</h2>
            <p className="section-sub">5 different worlds, 5 unique experiences — all designed for local multiplayer fun.</p>
          </div>
          <a href="#games" className="link-pill">
            View All Games <ArrowRight size={16} />
          </a>
        </div>

        <div className="games-grid">
          {games.map((game, i) => (
            <article key={game.id} className="card game-card" style={{ '--accent': game.accent }}>
              <div className="game-thumb">
                <Cover image={game.image} art={game.art} title={game.title} seed={i + 1} width={300} height={280} />
              </div>
              <div className="game-body">
                <h3>{game.title}</h3>
                <p>{game.description}</p>
                <div className="game-meta">
                  <span className="chip chip-genre">{game.genre}</span>
                  <span className="chip chip-muted">
                    <Users size={12} /> {game.players}
                  </span>
                </div>
                <a href={`#/play/${game.id}`} className="btn btn-primary btn-sm btn-block">
                  Play Now <ArrowRight size={15} />
                </a>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
