import { View, StyleSheet } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

// A small round mark per kind of line on the brain tab (5.11.2026): the decisions log's kinds
// (llm/brainlog.ts) and the ledger's (llm/audit.ts), each a tiny line drawing on a tint of
// its colour, so a column of them reads at a glance: plans, skips, loads, prompts, the night.
export type GlyphKind =
  | 'plan' | 'skip' | 'load' | 'dispatch' | 'retry' | 'night' | 'unit' | 'check' | 'out' | 'error'
  | 'pair' | 'connect' | 'reject' | 'claim' | 'health' | 'end';

const SIZE = 26;

function Mark({ kind, color }: { kind: string; color: string }) {
  const p = { stroke: color, strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'plan': // a fork: one model, shared out
      return <Path d="M6 12h4M10 12l4-4h4M10 12l4 4h4" {...p} />;
    case 'skip': // past a device
      return <Path d="M6 15c2-6 8-6 10 0M14 13l2 2.4 2.4-2" {...p} />;
    case 'load': // into memory
      return <Path d="M12 5v9M8.5 10.5L12 14l3.5-3.5M6.5 18h11" {...p} />;
    case 'dispatch': // a prompt sent on
      return <Path d="M6 12h11M13.5 8.5L17 12l-3.5 3.5" {...p} />;
    case 'retry':
      return <Path d="M16.5 9.5A5 5 0 1 0 17 13M17 6v3.8h-3.8" {...p} />;
    case 'night': // a moon
      return <Path d="M15.5 15.8A5.5 5.5 0 0 1 10 6.2a5.6 5.6 0 1 0 5.5 9.6z" {...p} />;
    case 'unit':
      return <Path d="M7 12.5l3 3 7-7" {...p} />;
    case 'check':
    case 'reject':
      return <Path d="M8 8l8 8M16 8l-8 8" {...p} />;
    case 'out': // sitting out: pause
      return <Path d="M10 7.5v9M14 7.5v9" {...p} />;
    case 'error':
      return (
        <>
          <Path d="M12 6.5v7" {...p} />
          <Circle cx={12} cy={17} r={0.9} fill={color} />
        </>
      );
    case 'pair': // two links
      return <Path d="M10.5 13.5l3-3M9 11l-1.5 1.5a2.5 2.5 0 0 0 3.5 3.5L12.5 14.5M15 13l1.5-1.5a2.5 2.5 0 0 0-3.5-3.5L11.5 9.5" {...p} />;
    case 'connect': // two devices, a line
      return (
        <>
          <Rect x={5} y={8.5} width={5} height={7} rx={1.2} {...p} />
          <Rect x={14} y={8.5} width={5} height={7} rx={1.2} {...p} />
          <Path d="M10 12h4" {...p} />
        </>
      );
    case 'claim': // claimed against measured: two bars
      return <Path d="M8 17V9M12 17V6.5M16 17v-5.5" {...p} />;
    case 'health': // a pulse
      return <Path d="M5 12.5h3l1.6-4 2.8 8 1.8-4H19" {...p} />;
    case 'end':
      return <Rect x={8} y={8} width={8} height={8} rx={1.5} {...p} />;
    default:
      return <Circle cx={12} cy={12} r={2.5} fill={color} />;
  }
}

export default function BrainGlyph({ kind, color }: { kind: string; color: string }) {
  return (
    <View style={[styles.wrap, { borderColor: color }]}>
      <View style={[StyleSheet.absoluteFill, styles.tint, { backgroundColor: color }]} />
      <Svg width={SIZE - 4} height={SIZE - 4} viewBox="0 0 24 24">
        <Mark kind={kind} color={color} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tint: { opacity: 0.12 },
});
