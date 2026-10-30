import { useState } from 'react';
import { ArrowRight, Check, Heart } from 'lucide-react';
import Logo from './Logo.jsx';
import { socials } from './SocialIcons.jsx';
import { footerLinks } from '../data.js';

function Newsletter() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);

  const onSubmit = (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setDone(true);
    setEmail('');
  };

  return (
    <div className="newsletter">
      <h4>Stay Updated</h4>
      <p>Get the latest news and tournament updates.</p>
      {done ? (
        <p className="newsletter-done">
          <Check size={16} /> You’re on the list — see you in the arena!
        </p>
      ) : (
        <form onSubmit={onSubmit}>
          <label htmlFor="newsletter-email" className="sr-only">
            Email address
          </label>
          <input
            id="newsletter-email"
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button type="submit" aria-label="Subscribe">
            <ArrowRight size={18} />
          </button>
        </form>
      )}
    </div>
  );
}

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <Logo />
            <p>One screen. Many players. Endless fun.</p>
            <div className="socials">
              {socials.map(({ label, href, Icon }) => (
                <a key={label} href={href} aria-label={label}>
                  <Icon />
                </a>
              ))}
            </div>
          </div>

          {footerLinks.map((col) => (
            <div key={col.title} className="footer-col">
              <h4>{col.title}</h4>
              <ul>
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <Newsletter />
        </div>

        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} PlayVerse. All rights reserved.</span>
          <span>
            Made with <Heart className="heart" size={14} fill="currentColor" /> for gamers.
          </span>
        </div>
      </div>
    </footer>
  );
}
