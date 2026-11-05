import { memo, useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import Animated, { cancelAnimation, Easing, useAnimatedProps, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import type { PeerBadge } from '@/llm/audit';
import { VERDICT_COLOR } from '@/theme/audit';
import { colors, fonts } from '@/theme/tokens';
import { edge, fit, orbit, ringDash, type Pt } from './geometry';
import type { NodeState } from './stats';
import { STATE_COLOR } from './colors';

// The brain, drawn (5.11.2026): this phone in the middle, every paired device around it, a
// line to each. A node's ring is filled by how much of the model it holds and coloured by
// its state; the small dot on its shoulder is the checker's badge. The node that is
// answering pulses (a still halo when the phone asks for less motion). The picture has no
// words but the names; the whole of it is said in accessibilityLabel.

export type FigureNode = {
  id: string;
  name: string;
  share: number; // 0..1 of the model
  state: NodeState;
  badge: PeerBadge;
  kind?: 'phone' | 'tablet' | 'pc';
};

const W = 320;
const H = 232;
const C: Pt = { x: W / 2, y: 106 };
const RX = 120;
const RY = 78;
const R_CENTER = 30;
const R_PEER = 17;
const STROKE = 4;
const MAX = 8;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function Pulse({ x, y, r, color }: { x: number; y: number; r: number; color: string }) {
  const reduce = useReducedMotion();
  const v = useSharedValue(0);
  useEffect(() => {
    if (reduce) return;
    v.set(withRepeat(withTiming(1, { duration: 1500, easing: Easing.out(Easing.cubic) }), -1, false));
    return () => cancelAnimation(v);
  }, [reduce, v]);
  const props = useAnimatedProps(() => ({ r: r + 2 + v.value * 13, opacity: 0.4 * (1 - v.value) }));
  if (reduce) return <Circle cx={x} cy={y} r={r + 6} fill="none" stroke={color} strokeWidth={1.5} opacity={0.55} />;
  return <AnimatedCircle cx={x} cy={y} fill={color} animatedProps={props} />;
}

// a device's outline inside its node, scaled to the node
function Device({ x, y, r, kind, color }: { x: number; y: number; r: number; kind: FigureNode['kind']; color: string }) {
  const s = r / 17;
  const p = { stroke: color, strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (kind === 'pc') {
    return (
      <G transform={`translate(${x} ${y}) scale(${s})`}>
        <Rect x={-7.5} y={-6} width={15} height={10} rx={1.5} {...p} />
        <Path d="M-3.5 7.5h7M0 4v3.5" {...p} />
      </G>
    );
  }
  const w = kind === 'tablet' ? 12 : 8.5;
  const h = kind === 'tablet' ? 14 : 14.5;
  return (
    <G transform={`translate(${x} ${y}) scale(${s})`}>
      <Rect x={-w / 2} y={-h / 2} width={w} height={h} rx={2} {...p} />
      <Path d={`M-1.2 ${h / 2 - 2.2}h2.4`} {...p} />
    </G>
  );
}

function Node({ at, r, n, label }: { at: Pt; r: number; n: FigureNode; label: boolean }) {
  const color = STATE_COLOR[n.state];
  const ring = ringDash(n.share, r);
  const dot = r * 0.72;
  return (
    <G>
      {n.state === 'busy' ? <Pulse x={at.x} y={at.y} r={r} color={color} /> : null}
      <Circle cx={at.x} cy={at.y} r={r} fill={colors.ink} stroke={colors.ink3} strokeWidth={STROKE} />
      <Circle cx={at.x} cy={at.y} r={r - STROKE / 2 - 1} fill={color} opacity={n.state === 'saved' ? 0.06 : 0.12} />
      {ring.length > 0 ? (
        <Circle
          cx={at.x}
          cy={at.y}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeDasharray={ring.dash}
          strokeLinecap={n.share >= 1 ? 'butt' : 'round'}
          transform={`rotate(-90 ${at.x} ${at.y})`}
        />
      ) : null}
      <Device x={at.x} y={at.y} r={r} kind={n.kind ?? 'phone'} color={n.state === 'saved' ? colors.meta : colors.paper} />
      {n.badge !== 'none' ? <Circle cx={at.x + dot} cy={at.y - dot} r={r > 20 ? 5.5 : 4.5} fill={VERDICT_COLOR[n.badge]} stroke={colors.ink} strokeWidth={2} /> : null}
      {label ? (
        <SvgText x={at.x} y={at.y + r + 13} fontSize={10} fontFamily={fonts.regular} fill={colors.mute} textAnchor="middle">
          {n.name.length > 11 ? `${n.name.slice(0, 10)}…` : n.name}
        </SvgText>
      ) : null}
    </G>
  );
}

function link(state: NodeState): { stroke: string; width: number; dash?: string } {
  if (state === 'busy') return { stroke: STATE_COLOR.busy, width: 2 };
  if (state === 'idle') return { stroke: colors.rule, width: 1.5 };
  return { stroke: state === 'saved' ? colors.ink3 : STATE_COLOR[state], width: 1.5, dash: '3 4' };
}

function BrainFigure({ center, peers, label, onPress, hint }: { center: FigureNode; peers: FigureNode[]; label: string; onPress?: () => void; hint?: string }) {
  const { shown, more } = fit(peers, MAX);
  const slots = orbit(shown.length + (more ? 1 : 0), C.x, C.y, RX, RY);
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessible accessibilityRole={onPress ? 'button' : 'image'} accessibilityLabel={label} accessibilityHint={hint} style={styles.wrap}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`}>
        {shown.map((n, i) => {
          const s = slots[i];
          const a = edge(C, s, R_CENTER + 4);
          const b = edge(s, C, R_PEER + 4);
          const l = link(n.state);
          return <Line key={`l-${n.id}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={l.stroke} strokeWidth={l.width} strokeDasharray={l.dash} strokeLinecap="round" />;
        })}
        {more ? (() => {
          const s = slots[shown.length];
          const a = edge(C, s, R_CENTER + 4);
          const b = edge(s, C, R_PEER + 4);
          return (
            <G>
              <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={colors.ink3} strokeWidth={1.5} strokeDasharray="3 4" />
              <Circle cx={s.x} cy={s.y} r={R_PEER} fill={colors.ink2} />
              <SvgText x={s.x} y={s.y + 4} fontSize={11} fontFamily={fonts.medium} fill={colors.mute} textAnchor="middle">{`+${more}`}</SvgText>
            </G>
          );
        })() : null}
        {shown.map((n, i) => <Node key={n.id} at={slots[i]} r={R_PEER} n={n} label />)}
        <Node at={C} r={R_CENTER} n={center} label={false} />
      </Svg>
    </Pressable>
  );
}

export default memo(BrainFigure);

const styles = StyleSheet.create({
  wrap: { width: '100%', aspectRatio: W / H, maxHeight: 300, alignSelf: 'center' },
});
