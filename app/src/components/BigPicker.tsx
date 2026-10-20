import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

export type BigOption = { id: string; label: string; count?: number };
type Props = {
  open: boolean;
  title: string;
  options: BigOption[];
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
};

// A choice set large, like a poster, the same as the country step of the place picker:
// the selected one in paper with its count in red, the rest dimmed.
export default function BigPicker({ open, title, options, selected, onSelect, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { up } = useLang();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.dim} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.grip} />
        <Text style={styles.step}>{up(title)}</Text>
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          {options.map((o) => {
            const on = o.id === selected;
            const empty = o.count === 0;
            return (
              <Pressable
                key={o.id}
                onPress={() => {
                  onSelect(o.id);
                  onClose();
                }}
                accessibilityRole="button"
                accessibilityLabel={o.label}
                accessibilityState={{ selected: on }}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <Text style={[styles.item, on && styles.on, empty && !on && styles.empty]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {o.label}
                  {o.count !== undefined ? <Text style={[styles.sup, on && styles.supOn]}>{`  ${o.count}`}</Text> : null}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { flex: 1, backgroundColor: 'rgba(255,255,255,0.6)' },
  sheet: { backgroundColor: colors.ink, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.ink3, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingHorizontal: brand.left, paddingTop: 10, maxHeight: '80%' },
  grip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.ink3, marginBottom: 14 },
  step: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.4, color: colors.meta, marginBottom: 8 },
  list: { flexGrow: 0 },
  pressed: { opacity: 0.6 },
  item: { fontFamily: fonts.semibold, fontSize: 38, lineHeight: 44, letterSpacing: -1.4, color: colors.ink3 },
  on: { color: colors.paper },
  empty: { color: colors.ink3 },
  sup: { fontFamily: fonts.jet, fontSize: 12, letterSpacing: 0.4, color: colors.meta },
  supOn: { color: colors.spotText },
});
