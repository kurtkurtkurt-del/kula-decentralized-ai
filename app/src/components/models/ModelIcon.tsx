import Svg, { Circle, Path } from 'react-native-svg';

// The models' small pictures (6.11.2026): one per thing a model is good at (the words moved
// into InfoTip bubbles), the fit marks, and the crown that marks the main device (the one
// that loads the model and uses the others). 1.5 px lines on a 24 grid, as components/Icon.
export type ModelIconName =
  | 'chat' | 'fast' | 'summary' | 'translate' | 'extract' | 'write' | 'reason' | 'code' | 'quality'
  | 'fits' | 'tight' | 'no' | 'together'
  | 'crown' | 'qr' | 'list' | 'wifi';

export default function ModelIcon({ name, size = 16, color, strokeWidth = 1.6 }: { name: ModelIconName; size?: number; color: string; strokeWidth?: number }) {
  const p = { stroke: color, strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'chat' && <><Path d="M4 5h16v11H11l-4.5 3.5V16H4z" {...p} /><Path d="M8 9.5h8M8 12.5h5" {...p} /></>}
      {/* a bolt: small and quick */}
      {name === 'fast' && <Path d="M13 3 5.5 13.5h6L10.5 21 18 10.5h-6z" {...p} />}
      {/* lines getting shorter: a long text made short */}
      {name === 'summary' && <Path d="M5 6h14M5 10h14M5 14h9M5 18h5" {...p} />}
      {/* a sign and a letter: from one language to another */}
      {name === 'translate' && <><Path d="M4 6h8M8 4v2M5.5 6c.6 3 2.8 5.4 5.5 6.5M10.5 6c-.6 3-2.8 5.4-5.5 6.5" {...p} /><Path d="M13 20.5 16.5 12l3.5 8.5M14.3 17.5h4.4" {...p} /></>}
      {/* a funnel: the fields out of a text */}
      {name === 'extract' && <Path d="M4 5h16l-6 7.5v5.5l-4 2v-7.5z" {...p} />}
      {name === 'write' && <><Path d="M4.5 19.5 5.5 15.5 16 5l3 3L8.5 18.5z" {...p} /><Path d="M14 7l3 3" {...p} /></>}
      {/* a bulb: thinks before it answers */}
      {name === 'reason' && <><Path d="M9.5 17.5h5M10.5 20.5h3" {...p} /><Path d="M12 3.5a5.8 5.8 0 0 0-3.4 10.5c.6.5.9 1.2.9 2h5c0-.8.3-1.5.9-2A5.8 5.8 0 0 0 12 3.5z" {...p} /></>}
      {name === 'code' && <Path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15" {...p} />}
      {name === 'quality' && <Path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" {...p} />}
      {name === 'fits' && <Path d="M5 12.5l4.5 4.5L19 7.5" {...p} />}
      {name === 'tight' && <Path d="M4 13c2.5-3 5-3 8 0s5.5 3 8 0" {...p} />}
      {name === 'no' && <Path d="M7 7l10 10M17 7 7 17" {...p} />}
      {name === 'together' && <><Circle cx={8} cy={9} r={2.6} {...p} /><Circle cx={16} cy={9} r={2.6} {...p} /><Path d="M3.5 19a4.5 4.5 0 0 1 9 0M11.5 19a4.5 4.5 0 0 1 9 0" {...p} /></>}
      {/* the main device: the one that loads the model and uses the others */}
      {name === 'crown' && <><Path d="M4.5 17 3 7.5l5 4 4-6.5 4 6.5 5-4L19.5 17z" {...p} fill={color} /><Path d="M5 20.5h14" {...p} /></>}
      {name === 'qr' && <><Path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" {...p} /><Path d="M14 14h2.5v2.5H14zM18 18h2v2h-2zM18 14h2M14 19h2" {...p} /></>}
      {name === 'list' && <><Circle cx={5.5} cy={7} r={1.2} {...p} /><Circle cx={5.5} cy={12} r={1.2} {...p} /><Circle cx={5.5} cy={17} r={1.2} {...p} /><Path d="M9.5 7h10M9.5 12h10M9.5 17h10" {...p} /></>}
      {name === 'wifi' && <><Path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" {...p} /><Circle cx={12} cy={19} r={0.8} {...p} fill={color} /></>}
    </Svg>
  );
}
