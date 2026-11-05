import { useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { colors, fonts, radius } from '@/theme/tokens';

// A small tap target (an "i" in a circle, or any child) that opens a little speech bubble
// next to it with one or two sentences (6.11.2026: model tags became icons, the meaning
// moved into these bubbles; copy json and the passport use them too). A tap anywhere closes it.
type Props = {
  text: string;
  title?: string;
  children?: ReactNode; // what to tap; default: an "i" in a circle
  size?: number;
  color?: string;
  accessibilityLabel?: string;
};

const W = 240;

export default function InfoTip({ text, title, children, size = 18, color = colors.mute, accessibilityLabel }: Props) {
  const ref = useRef<View>(null);
  const [at, setAt] = useState<{ x: number; y: number; h: number } | null>(null);
  const win = useWindowDimensions();

  const open = () => {
    ref.current?.measureInWindow((x, y, w, h) => setAt({ x: x + w / 2, y, h }));
  };

  const below = at ? at.y < win.height * 0.6 : true;
  const left = at ? Math.min(Math.max(12, at.x - W / 2), win.width - W - 12) : 0;
  const tail = at ? Math.min(Math.max(14, at.x - left - 6), W - 26) : 0;

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title ?? text}
      >
        {children ?? (
          <View style={[s.i, { width: size, height: size, borderRadius: size / 2, borderColor: color }]}>
            <Text style={[s.iText, { color, fontSize: size * 0.62, lineHeight: size * 0.9 }]}>i</Text>
          </View>
        )}
      </Pressable>
      <Modal transparent visible={!!at} animationType="fade" onRequestClose={() => setAt(null)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setAt(null)}>
          {at && (
            <View
              style={[
                s.bubble,
                { left, width: W },
                below ? { top: at.y + at.h + 8 } : { bottom: win.height - at.y + 8 },
              ]}
            >
              <View style={[s.tail, { left: tail }, below ? { top: -6 } : { bottom: -6 }]} />
              {title ? <Text style={s.title}>{title}</Text> : null}
              <Text style={s.text}>{text}</Text>
            </View>
          )}
        </Pressable>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  i: { borderWidth: 1.2, alignItems: 'center', justifyContent: 'center' },
  iText: { fontFamily: fonts.semibold, textAlign: 'center' },
  bubble: {
    position: 'absolute',
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  tail: { position: 'absolute', width: 12, height: 12, backgroundColor: colors.paper, transform: [{ rotate: '45deg' }] },
  title: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 13, marginBottom: 2 },
  text: { fontFamily: fonts.regular, color: colors.ink2, fontSize: 13, lineHeight: 18 },
});
