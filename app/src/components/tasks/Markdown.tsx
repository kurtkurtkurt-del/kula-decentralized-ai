import { Fragment } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius } from '@/theme/tokens';

// A project's answer as simple markdown (5.11.2026): headings (#), lists (-, *, 1.), code
// blocks (```), **bold** and `code` inside a line; everything else is a paragraph. Enough
// for what a small model writes; no links, no tables (they show as their text).

export type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'li'; mark: string; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'p'; text: string };

/** The answer cut into blocks (pure). */
export function blocksOf(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r/g, '').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      out.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ kind: 'h', level: h[1].length, text: h[2].trim() });
    } else if (li) {
      flush();
      out.push({ kind: 'li', mark: /\d/.test(li[1]) ? li[1].replace(')', '.') : '•', text: li[2] });
    } else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return out;
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <Text key={i} style={styles.bold}>{p.slice(2, -2)}</Text>
        ) : p.startsWith('`') && p.endsWith('`') ? (
          <Text key={i} style={styles.codeInline}>{p.slice(1, -1)}</Text>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export default function Markdown({ text }: { text: string }) {
  return (
    <View style={styles.root}>
      {blocksOf(text).map((b, i) =>
        b.kind === 'h' ? (
          <Text key={i} style={[styles.h, b.level === 1 && styles.h1]} selectable><Inline text={b.text} /></Text>
        ) : b.kind === 'li' ? (
          <View key={i} style={styles.li}>
            <Text style={styles.mark}>{b.mark}</Text>
            <Text style={styles.p} selectable><Inline text={b.text} /></Text>
          </View>
        ) : b.kind === 'code' ? (
          <View key={i} style={styles.code}><Text style={styles.codeText} selectable>{b.text}</Text></View>
        ) : (
          <Text key={i} style={styles.p} selectable><Inline text={b.text} /></Text>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  h: { fontFamily: fonts.semibold, fontSize: 17, letterSpacing: -0.3, color: colors.paper, marginTop: 6 },
  h1: { fontSize: 20 },
  p: { flex: 1, fontFamily: fonts.regular, fontSize: 15.5, lineHeight: 23, color: colors.paper },
  li: { flexDirection: 'row', gap: 8, paddingLeft: 2 },
  mark: { fontFamily: fonts.medium, fontSize: 15.5, lineHeight: 23, color: colors.mute, minWidth: 14 },
  bold: { fontFamily: fonts.semibold },
  codeInline: { fontFamily: fonts.jet, fontSize: 13.5, backgroundColor: colors.ink2 },
  code: { backgroundColor: colors.ink2, borderRadius: radius.sm, padding: 12 },
  codeText: { fontFamily: fonts.jet, fontSize: 12.5, lineHeight: 18, color: colors.paper },
});
