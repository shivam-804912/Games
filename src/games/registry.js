import strikeArena from './strike-arena.js';
import cityAdventure from './city-adventure.js';
import battleClash from './battle-clash.js';
import galaxyQuest from './galaxy-quest.js';
import racingRivals from './racing-rivals.js';

// Keyed by the same ids as the landing page's game cards (src/data.js).
export const GAMES = {
  [strikeArena.id]: strikeArena,
  [cityAdventure.id]: cityAdventure,
  [battleClash.id]: battleClash,
  [galaxyQuest.id]: galaxyQuest,
  [racingRivals.id]: racingRivals,
};
