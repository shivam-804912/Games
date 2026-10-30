import { useState } from 'react';
import { ChevronDown, MessageCircleQuestion } from 'lucide-react';
import { faqs } from '../data.js';

export default function Faq() {
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <section id="support" className="section section-tight">
      <div className="container">
        <h2 className="section-title upper with-icon">
          <MessageCircleQuestion className="title-icon" size={26} /> Frequently Asked Questions
        </h2>

        <div className="faq-list">
          {faqs.map(({ q, a }, i) => {
            const open = openIndex === i;
            return (
              <div key={q} className={`faq-item ${open ? 'is-open' : ''}`}>
                <h3>
                  <button
                    type="button"
                    className="faq-q"
                    id={`faq-q-${i}`}
                    aria-expanded={open}
                    aria-controls={`faq-a-${i}`}
                    onClick={() => setOpenIndex(open ? null : i)}
                  >
                    {q}
                    <ChevronDown size={18} />
                  </button>
                </h3>
                <div className="faq-a" id={`faq-a-${i}`} role="region" aria-labelledby={`faq-q-${i}`}>
                  <div>
                    <p>{a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
