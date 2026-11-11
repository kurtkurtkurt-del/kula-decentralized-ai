import type { Branch, BranchMaker, BranchView, Suggestion } from '@godseye/core';
import { sayCheck, sayHeadline, type ClusterReport, type Verdict } from '@/llm/trust';

// Branch 8 on the phone (11.11.2026): trust and verification is the phone's own security report
// (llm/trust.ts, trustStore.ts), handed to the shared eye as a branch of its own (EyeOptions.makers).
// The computer's trust branch checks signatures and certificates with node:crypto, synchronously,
// every look; Hermes has neither Ed25519 nor P-256, and the phone already verifies every device's
// certificate and ledger natively (TrustVerify.kt) once a minute while the report is on screen. So
// on the phone the eye does not check a second time: it reads that report, in the reader's language,
// and says when the verdict changes. The same rules, the same words as the trust screen.

type Tx = (key: string, fallback?: string, vars?: Record<string, string | number>) => string;
export type TrustSource = { report: () => ClusterReport; tx: () => Tx; self: () => string };

export function phoneTrust(src: TrustSource): BranchMaker {
  return (ctx): Branch => {
    let r: ClusterReport | null = null;
    let said: Verdict | null = null;
    return {
      id: 'trust',
      observe() {
        r = src.report();
        if (said !== null && said !== r.verdict) ctx.emit(`${src.tx()(`trust.verdict.${r.verdict}`)}: ${sayHeadline(r.headline, src.tx(), src.self())}`);
        said = r.verdict;
      },
      view(): BranchView {
        if (!r) return { built: true, stat: 'looking…', gauge: null, rows: [], lines: [] };
        const tx = src.tx();
        const self = src.self();
        const okN = r.devices.filter((d) => d.verdict === 'ok').length;
        const headline = sayHeadline(r.headline, tx, self);
        const suggestions: Suggestion[] = r.verdict === 'bad'
          ? [{ id: 'trust:bad', kind: 'warn', title: headline, why: tx('eye.trust.why'), action: { do: 'open', panel: 'branch', branch: 'trust' }, weight: 3 }]
          : [];
        return {
          built: true,
          stat: tx(`trust.verdict.${r.verdict}`),
          gauge: r.devices.length ? Math.round((okN / r.devices.length) * 100) : null,
          rows: [[self, sayCheck(r.host, tx)], ...r.devices.map((d): [string, string] => [d.name, tx(`trust.verdict.${d.verdict}`)])],
          lines: r.devices.flatMap((d) => d.checks.filter((c) => c.ok === false).map((c) => `${d.name}: ${sayCheck(c, tx)}`)),
          note: tx('eye.trust.note'),
          suggestions,
        };
      },
    };
  };
}
