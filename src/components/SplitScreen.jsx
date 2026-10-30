import GameArt from './GameArt.jsx';

// Two-player split-screen racing view, used on the hero TV and in "How it works".
export default function SplitScreen({ players = ['P1', 'P2'], hud = false }) {
  return (
    <div className="split-screen" aria-hidden="true">
      <div className="split-pane">
        <GameArt variant="racing" seed={3} width={224} height={250} palette={['#2f6bff', '#ff3b5c']} />
        <span className="ptag ptag-blue">{players[0]}</span>
        {hud && (
          <span className="hud">
            128<small>km/h</small>
          </span>
        )}
      </div>
      <div className="split-pane">
        <GameArt variant="racing" seed={11} width={224} height={250} palette={['#ff3b5c', '#2f6bff']} />
        <span className="ptag ptag-red">{players[1]}</span>
        {hud && (
          <span className="hud">
            LAP<small>2 / 3</small>
          </span>
        )}
      </div>
    </div>
  );
}
