import type { PeerBadge } from '@/llm/audit';
import { colors } from './tokens';

/** The audit badge colours, from the tokens: refused terracotta, warning gold, verified sage, not seen meta. */
export const VERDICT_COLOR: Record<PeerBadge, string> = { rejected: colors.violet, warn: colors.gold, verified: colors.green, none: colors.meta };
