import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { night } from '@/theme/tokens';

// kula's own picture (5.11.2026, in place of afterhours' concert photo): a calm night, a few
// phones lying down on charge, each with a small bolt, thin glowing lines joining them into
// one network, and some stars. Drawn in code, so it is sharp at every size and costs no
// asset; it fills its parent (slice), the phones in the lower half so a title fits above.
// seed moves the stars and turns the phones a little, so two places need not look alike.

const W = 360;
const H = 640;

type PhoneAt = { x: number; y: number; r: number };
const PHONES: PhoneAt[] = [
  { x: 92, y: 430, r: -14 },
  { x: 196, y: 398, r: 8 },
  { x: 288, y: 452, r: -6 },
  { x: 140, y: 540, r: 18 },
  { x: 252, y: 560, r: -20 },
];
// who is joined to whom: a ring with two chords, as a small cluster looks
const LINKS: [number, number][] = [[0, 1], [1, 2], [2, 4], [4, 3], [3, 0], [1, 3], [1, 4]];

/** A small deterministic generator, so the picture is the same on every render. */
export function lcg(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function starsFor(seed: number, n = 34) {
  const rnd = lcg(seed);
  return Array.from({ length: n }, () => ({ x: rnd() * W, y: rnd() * H * 0.56, r: 0.5 + rnd() * 1.3, o: 0.25 + rnd() * 0.6 }));
}

function Phone({ p, turn }: { p: PhoneAt; turn: number }) {
  const w = 34;
  const h = 62;
  return (
    <G transform={`translate(${p.x} ${p.y}) rotate(${p.r + turn})`}>
      {/* the soft light the screen throws on the table */}
      <Rect x={-w / 2 - 8} y={-h / 2 - 8} width={w + 16} height={h + 16} rx={14} fill="url(#halo)" />
      <Rect x={-w / 2} y={-h / 2} width={w} height={h} rx={7} fill={night.phone} stroke={night.edge} strokeWidth={1} />
      <Rect x={-w / 2 + 3} y={-h / 2 + 4} width={w - 6} height={h - 8} rx={4} fill={night.screen} />
      <Rect x={-w / 2 + 3} y={-h / 2 + 4} width={w - 6} height={h - 8} rx={4} fill={night.lit} opacity={0.18} />
      {/* charging: a small bolt */}
      <Path d="M1.5 -9 L-5 1.5 L-0.8 1.5 L-2.5 9 L5 -2 L0.8 -2 Z" fill={night.bolt} opacity={0.95} />
      {/* the cable, out of the bottom edge */}
      <Path d={`M0 ${h / 2} q 0 14 -10 22`} stroke={night.edge} strokeWidth={1.4} fill="none" strokeLinecap="round" />
    </G>
  );
}

function NightNetwork({ style, seed = 7 }: { style?: StyleProp<ViewStyle>; seed?: number }) {
  const stars = starsFor(seed);
  const turn = (lcg(seed * 31 + 3)() - 0.5) * 10;
  return (
    <View style={[styles.fill, style]} pointerEvents="none">
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <Defs>
          {/* userSpaceOnUse: the moon's shadow circle is painted with the same sky */}
          <LinearGradient id="sky" x1="0" y1="0" x2="0" y2={H} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={night.sky0} />
            <Stop offset="0.55" stopColor={night.sky1} />
            <Stop offset="1" stopColor={night.sky2} />
          </LinearGradient>
          <RadialGradient id="halo" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={night.lit} stopOpacity={0.35} />
            <Stop offset="1" stopColor={night.lit} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="node" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={night.line} stopOpacity={0.5} />
            <Stop offset="1" stopColor={night.line} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={W} height={H} fill="url(#sky)" />
        {stars.map((s, i) => (
          <Circle key={i} cx={s.x} cy={s.y} r={s.r} fill={night.star} opacity={s.o} />
        ))}
        {/* a thin moon */}
        <Circle cx={286} cy={92} r={22} fill={night.star} opacity={0.9} />
        <Circle cx={296} cy={84} r={20} fill="url(#sky)" />
        {/* the network: a wide faint line under a thin bright one reads as a glow */}
        {LINKS.map(([a, b]) => (
          <Line key={`g${a}${b}`} x1={PHONES[a].x} y1={PHONES[a].y} x2={PHONES[b].x} y2={PHONES[b].y} stroke={night.line} strokeWidth={6} opacity={0.08} strokeLinecap="round" />
        ))}
        {LINKS.map(([a, b]) => (
          <Line key={`l${a}${b}`} x1={PHONES[a].x} y1={PHONES[a].y} x2={PHONES[b].x} y2={PHONES[b].y} stroke={night.line} strokeWidth={1} opacity={0.6} strokeLinecap="round" />
        ))}
        {PHONES.map((p, i) => (
          <Circle key={`n${i}`} cx={p.x} cy={p.y} r={48} fill="url(#node)" />
        ))}
        {PHONES.map((p, i) => (
          <Phone key={`p${i}`} p={p} turn={i % 2 ? turn : -turn} />
        ))}
      </Svg>
    </View>
  );
}

export default memo(NightNetwork);

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden', backgroundColor: night.sky1 },
});
