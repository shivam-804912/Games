import { features } from '../data.js';

export default function WhyUs() {
  return (
    <section className="section" aria-labelledby="why-title">
      <div className="container">
        <span className="eyebrow">Why PlayVerse?</span>
        <h2 id="why-title" className="section-title">
          More Than Just Games
        </h2>
        <p className="section-sub">A complete multiplayer experience for you and your friends.</p>

        <div className="why-grid">
          {features.map(({ icon: Icon, title, text, tone }) => (
            <div key={title} className="card why-card" style={{ '--tone': tone }}>
              <span className="why-icon">
                <Icon size={24} />
              </span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
