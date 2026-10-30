import { ArrowRight } from 'lucide-react';
import GameArt from './GameArt.jsx';

export default function FeaturedGame() {
  return (
    <section className="container featured" aria-labelledby="featured-title">
      <div className="featured-card">
        <GameArt variant="city" seed={21} width={1200} height={300} figure className="featured-art" />
        <div className="featured-shade" />
        <div className="featured-copy">
          <span className="tag-badge">Featured Game</span>
          <h2 id="featured-title" className="featured-title">
            <span>City</span> Adventure
          </h2>
          <p>A massive open world, endless possibilities. Explore, complete missions, drive vehicles and play with your friends.</p>
          <a href="#/play/city-adventure" className="btn btn-primary">
            Play Now <ArrowRight size={16} />
          </a>
        </div>
      </div>
    </section>
  );
}
