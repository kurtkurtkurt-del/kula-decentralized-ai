import type { NodeState } from './stats';
import type { Tone } from '@/llm/brainlog';
import { colors } from '@/theme/tokens';

// The brain tab's colours, from the tokens (5.11.2026). A node's ring: ready deep brown,
// working sage, sitting out gold, refused terracotta, paired but not in the model pale.
// Not the accent: with the red accent "working" would read as "refused".
export const STATE_COLOR: Record<NodeState, string> = {
  idle: colors.paper2,
  busy: colors.green,
  out: colors.gold,
  refused: colors.violet,
  saved: colors.meta,
};

export const TONE_COLOR: Record<Tone, string> = { info: colors.mute, ok: colors.green, warn: colors.gold, bad: colors.violet };

// the model's parts in the share bar, one per device, in order
export const PART_COLORS = [colors.paper2, colors.green, colors.gold, colors.violet, colors.meta, colors.blue] as const;
export const partColor = (i: number) => PART_COLORS[i % PART_COLORS.length];
