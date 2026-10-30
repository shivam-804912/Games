import Navbar from './components/Navbar.jsx';
import Hero from './components/Hero.jsx';
import FeaturedGame from './components/FeaturedGame.jsx';
import Games from './components/Games.jsx';
import HowItWorks from './components/HowItWorks.jsx';
import Tournaments from './components/Tournaments.jsx';
import Community from './components/Community.jsx';
import WhyUs from './components/WhyUs.jsx';
import Faq from './components/Faq.jsx';
import Footer from './components/Footer.jsx';

export default function App() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <FeaturedGame />
        <Games />
        <HowItWorks />
        <Tournaments />
        <Community />
        <WhyUs />
        <Faq />
      </main>
      <Footer />
    </>
  );
}
