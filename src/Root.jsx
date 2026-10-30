import { lazy, Suspense, useEffect, useState } from 'react';
import App from './App.jsx';

const GameHost = lazy(() => import('./games/GameHost.jsx'));
const Controller = lazy(() => import('./games/Controller.jsx'));

// Hash routes: #/play/<game-id> (big screen), #/join?room=CODE (phone controller).
// Any other hash is a normal in-page anchor on the landing site.
function parseRoute() {
  const h = location.hash;
  if (h.startsWith('#/play/')) return { page: 'play', id: decodeURIComponent(h.slice(7).split('?')[0]) };
  if (h.startsWith('#/join')) return { page: 'join' };
  return { page: 'site' };
}

export default function Root() {
  const [route, setRoute] = useState(parseRoute);

  useEffect(() => {
    const onHash = () =>
      setRoute((prev) => {
        const next = parseRoute();
        return prev.page === next.page && prev.id === next.id ? prev : next;
      });
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Coming back from a game to e.g. #games: scroll to that section once it exists.
  useEffect(() => {
    if (route.page !== 'site') return;
    const id = location.hash.slice(1);
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
  }, [route.page]);

  return (
    <Suspense fallback={<div className="route-loading">Loading…</div>}>
      {route.page === 'play' ? <GameHost key={route.id} gameId={route.id} /> : route.page === 'join' ? <Controller /> : <App />}
    </Suspense>
  );
}
