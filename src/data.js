import {
  CalendarDays,
  Gamepad2,
  PartyPopper,
  ShieldCheck,
  Smartphone,
  Swords,
  Trophy,
  Users,
  Zap,
} from 'lucide-react';

export const navLinks = [
  { id: 'home', label: 'Home' },
  { id: 'games', label: 'Games' },
  { id: 'how-it-works', label: 'How It Works' },
  { id: 'tournaments', label: 'Tournaments' },
  { id: 'community', label: 'Community' },
  { id: 'support', label: 'Support' },
];

export const heroStats = [
  { icon: Gamepad2, value: '5', label: 'Unique Games' },
  { icon: Users, value: '2-8', label: 'Players per Game' },
  { icon: Zap, value: '100%', label: 'Local Multiplayer' },
  { icon: Smartphone, value: 'No Extra Hardware', label: 'Just your phones' },
];

// `art` picks the illustrated scene drawn by <GameArt />.
// Add `image: '/images/strike-arena.jpg'` to use your own artwork instead.
export const games = [
  {
    id: 'strike-arena',
    title: 'Strike Arena',
    art: 'shooter',
    description: 'Fast-paced multiplayer shooting action. Team up or go solo and be the last one standing.',
    genre: 'Shooting',
    players: '2-8 Players',
    accent: '#8b93ff',
  },
  {
    id: 'city-adventure',
    title: 'City Adventure',
    art: 'city',
    description: 'Explore a massive open world, complete missions, drive vehicles and create your own story together.',
    genre: 'Open World',
    players: '2-4 Players',
    accent: '#22c3e6',
  },
  {
    id: 'battle-clash',
    title: 'Battle Clash',
    art: 'fight',
    description: 'Choose your fighter and battle with unique moves in intense 1v1 or team fights.',
    genre: 'Fighting',
    players: '2 Players',
    accent: '#ff4d6d',
  },
  {
    id: 'galaxy-quest',
    title: 'Galaxy Quest',
    art: 'space',
    description: 'Explore space, discover new planets, complete missions and survive together.',
    genre: 'Space',
    players: '2-4 Players',
    accent: '#4d7cff',
  },
  {
    id: 'racing-rivals',
    title: 'Racing Rivals',
    art: 'racing',
    description: 'High-speed multiplayer racing with stunning tracks. Compete, drift and be the fastest.',
    genre: 'Racing',
    players: '2-4 Players',
    accent: '#1fd1a5',
  },
];

export const steps = [
  {
    title: 'Choose a Game',
    text: 'Open PlayVerse on your TV or computer and select a game.',
  },
  {
    title: 'Connect Your Phones',
    text: 'Players join by scanning a QR code or entering a simple room code.',
  },
  {
    title: 'Use Your Phone as Controller',
    text: 'Each player gets their own on-screen controller with unique controls.',
  },
  {
    title: 'Play & Compete Together',
    text: 'All players play on the same screen at the same time. Compete, team up and have fun!',
  },
];

export const tournaments = [
  { id: 't1', art: 'shooter', title: 'Strike Arena Cup', format: '1v1 & 2v2 Matches', players: 32, prize: '₹10,000', inDays: 2 },
  { id: 't2', art: 'city', title: 'City Adventure Run', format: 'Open World Challenges', players: 24, prize: '₹8,000', inDays: 5 },
  { id: 't3', art: 'fight', title: 'Battle Clash League', format: '1v1 Fights', players: 16, prize: '₹5,000', inDays: 7 },
  { id: 't4', art: 'space', title: 'Galaxy Quest Expeditions', format: 'Co-op Missions', players: 20, prize: '₹9,000', inDays: 9 },
  { id: 't5', art: 'racing', title: 'Racing Rivals Grand Prix', format: 'Multiplayer Races', players: 28, prize: '₹8,000', inDays: 12 },
];

export const communityStats = [
  { icon: Users, value: '10K+', label: 'Active Players' },
  { icon: Swords, value: '500+', label: 'Daily Matches' },
  { icon: CalendarDays, value: '100+', label: 'Community Events' },
];

export const features = [
  { icon: PartyPopper, title: 'Play with Friends', text: 'Turn any gathering into a gaming party.', tone: '#14b8a6' },
  { icon: Gamepad2, title: 'Multiple Game Genres', text: 'Shooting, open world, fighting, space, racing and more.', tone: '#8b5cf6' },
  { icon: Trophy, title: 'Tournaments', text: 'Compete and win exciting rewards.', tone: '#f59e0b' },
  { icon: ShieldCheck, title: 'Safe & Secure', text: 'No personal data sharing. Just fun, fair and secure gaming.', tone: '#3b82f6' },
];

export const faqs = [
  {
    q: 'How do I connect my phone to play?',
    a: 'Open PlayVerse on your TV or computer and pick a game. A QR code and a 4-character room code appear on screen — scan the code with your phone camera (or open the link shown under it and type the code), and your phone instantly becomes a controller. Phones need to be on the same Wi-Fi as the big screen.',
  },
  {
    q: 'Do I need to install an app?',
    a: 'No. PlayVerse runs entirely in the browser. The big screen opens the game and every phone joins through its own browser — nothing to download or update.',
  },
  {
    q: 'How many players can play at the same time?',
    a: 'It depends on the game: Battle Clash is a 2-player fighter, City Adventure, Galaxy Quest and Racing Rivals support up to 4 players, and Strike Arena goes up to 8.',
  },
  {
    q: 'Can I play on a smart TV?',
    a: 'Yes. Open PlayVerse in your smart TV’s browser, or cast / connect a laptop over HDMI. Any screen that can show a web page works as the shared game screen.',
  },
  {
    q: 'Is it free to play?',
    a: 'Yes — all five games are free to play with friends, and community tournaments are free to enter.',
  },
];

export const footerLinks = [
  { title: 'Games', links: games.map((g) => ({ label: g.title, href: `#/play/${g.id}` })) },
  {
    title: 'Quick Links',
    links: [
      { label: 'Join on your phone', href: '#/join' },
      { label: 'How It Works', href: '#how-it-works' },
      { label: 'Tournaments', href: '#tournaments' },
      { label: 'Community', href: '#community' },
      { label: 'Support', href: '#support' },
      { label: 'Blog', href: '#' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy Policy', href: '#' },
      { label: 'Terms of Service', href: '#' },
      { label: 'Contact Us', href: '#' },
    ],
  },
];
