import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { colors } from '@/theme/tokens';

export type IconName = 'models' | 'chat' | 'brain' | 'people' | 'projects' | 'passport' | 'account';
type Props = { name: IconName; size?: number; color: string; strokeWidth?: number; filled?: boolean; hole?: string };

// 1.5 px line icons on a 24 grid. filled: the solid version of the tab icons (the open tab,
// as on Instagram); inner details are cut out in hole, the colour behind the icon.
export default function Icon({ name, size = 22, color, strokeWidth = 1.5, filled = false, hole = colors.ink }: Props) {
  const p = { stroke: color, strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const f = filled ? { ...p, fill: color } : p;
  const cut = { ...p, stroke: hole, fill: hole };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'models' && (
        <>
          {/* a model: a chip with pins (4.11.2026) */}
          <Rect x={6} y={6} width={12} height={12} rx={2} {...f} />
          <Rect x={9.5} y={9.5} width={5} height={5} rx={1} {...(filled ? cut : p)} />
          <Path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3" {...p} />
        </>
      )}
      {name === 'people' && (
        <>
          <Circle cx={9} cy={8.5} r={3} {...f} />
          <Path d={filled ? 'M3.5 19a5.5 5.5 0 0 1 11 0z' : 'M3.5 19a5.5 5.5 0 0 1 11 0'} {...f} />
          <Circle cx={16.5} cy={9.5} r={2.4} {...f} />
          <Path d={filled ? 'M15.5 14.2a4.6 4.6 0 0 1 5 4.8h-4.6z' : 'M15.5 14.2a4.6 4.6 0 0 1 5 4.8'} {...f} />
        </>
      )}
      {name === 'chat' && (
        <>
          <Path d="M4 5h16v11H11l-4.5 3.5V16H4z" {...p} />
          <Path d="M8 9.5h8M8 12.5h5" {...p} />
        </>
      )}
      {name === 'brain' && (
        <>
          {/* the brain (5.11.2026, where the network's three nodes were): two lobes, the
              seam between them, a fold in each */}
          <Path d="M12 5.6a3.1 3.1 0 0 0-5.4-1.4A3 3 0 0 0 3.9 7.8a3.1 3.1 0 0 0-.6 4.5 3.3 3.3 0 0 0 1.8 5.1A3.1 3.1 0 0 0 9 20a3 3 0 0 0 3-1.4z" {...f} />
          <Path d="M12 5.6a3.1 3.1 0 0 1 5.4-1.4 3 3 0 0 1 2.7 3.6 3.1 3.1 0 0 1 .6 4.5 3.3 3.3 0 0 1-1.8 5.1A3.1 3.1 0 0 1 15 20a3 3 0 0 1-3-1.4z" {...f} />
          <Path d="M12 5.6v13" {...(filled ? { ...p, stroke: hole } : p)} />
          <Path d="M7.4 9.6c1.2 0 2 .8 2 1.9M16.6 9.6c-1.2 0-2 .8-2 1.9M7 14.6c1.3 0 2.2.6 2.5 1.6M17 14.6c-1.3 0-2.2.6-2.5 1.6" {...(filled ? { ...p, stroke: hole } : p)} />
        </>
      )}
      {name === 'projects' && (
        <>
          {/* projects (5.11.2026): a sheet of work with a crescent moon on its corner, the
              night it runs in */}
          <Path d="M6 3.5h7.5L18 8v12.5H6z" {...f} />
          <Path d="M13.5 3.5V8H18" {...(filled ? { ...p, stroke: hole } : p)} />
          <Path d="M9 12.5h6M9 15.5h4" {...(filled ? { ...p, stroke: hole } : p)} />
          <Path d="M15.9 17.6a2.2 2.2 0 1 1-2.4-2.9 1.8 1.8 0 0 0 2.4 2.9z" {...(filled ? cut : p)} />
        </>
      )}
      {name === 'passport' && (
        <>
          {/* a passport: a booklet with a round stamp */}
          <Rect x={5} y={3} width={14} height={18} rx={2.5} {...f} />
          <Circle cx={12} cy={11} r={3.2} {...(filled ? cut : p)} />
          <Path d="M8.5 17h7" {...(filled ? { ...p, stroke: hole } : p)} />
        </>
      )}
      {name === 'account' && (
        <>
          <Circle cx={12} cy={8.5} r={3.5} {...p} />
          <Path d="M4.5 20a7.5 7.5 0 0 1 15 0" {...p} />
        </>
      )}
    </Svg>
  );
}
