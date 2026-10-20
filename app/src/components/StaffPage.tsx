import { useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View, type TextInputProps } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BackButton, { EdgeBack } from '@/components/BackButton';
import Input from '@/components/Input';
import PickerSheet from '@/components/PickerSheet';
import PullDownScroll from '@/components/PullDownScroll';
import { Mark } from '@/components/Row';
import { useLang } from '@/i18n';
import { colors, fonts } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The frame of every panel page: the title in the band, a scroll that closes by
// pulling down, the back button inline at the end. Same look as settings.
export default function StaffPage({ title, children, back = true }: { title: string; children: ReactNode; back?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      {back ? <EdgeBack /> : null}
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <PullDownScroll
          header={
            <View style={styles.band}>
              <Text style={styles.title}>{title}</Text>
            </View>
          }
          contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + (back ? 32 : 120) }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
          {back ? <BackButton inline /> : null}
        </PullDownScroll>
      </KeyboardAvoidingView>
    </View>
  );
}

// A label over a line field.
export function Field({ label, ...props }: { label: string } & TextInputProps) {
  const { up } = useLang();
  return (
    <>
      <Text style={styles.label}>{up(label)}</Text>
      <Input {...props} style={[props.multiline && styles.multi, props.style]} />
    </>
  );
}

// A label over a line that opens a list.
export function Choice({ label, value, options, onSelect, placeholder }: {
  label: string;
  value: string | null;
  options: { id: string; label: string }[];
  onSelect: (id: string) => void;
  placeholder?: string;
}) {
  const { up, t } = useLang();
  const [open, setOpen] = useState(false);
  const shown = options.find((o) => o.id === value)?.label;
  return (
    <>
      <Text style={styles.label}>{up(label)}</Text>
      <Pressable onPress={() => setOpen(true)} style={({ pressed }) => [styles.choice, pressed && styles.pressed]} accessibilityRole="button">
        <Text style={[styles.choiceText, !shown && styles.quiet]} numberOfLines={1}>
          {shown ?? placeholder ?? t('staff.f.pick')}
        </Text>
        <Mark kind="more" />
      </Pressable>
      <PickerSheet open={open} title={label} options={options} selected={value} onSelect={onSelect} onClose={() => setOpen(false)} />
    </>
  );
}

// A line under a form: what went wrong, or that it was saved.
export function Said({ text, bad }: { text: string | null; bad?: boolean }) {
  return text ? <Text style={[styles.said, bad && styles.bad]}>{text}</Text> : null;
}

export function Quiet({ text }: { text: string }) {
  return <Text style={styles.note}>{text}</Text>;
}

export const staffStyles = StyleSheet.create({
  save: { marginTop: 32, marginBottom: 18, gap: 10 },
  gap: { marginTop: 24 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 40, backgroundColor: colors.ink, zIndex: 2 },
  title: { position: 'absolute', top: brand.top, left: 0, right: 0, textAlign: 'center', fontFamily: fonts.medium, fontSize: brand.smallSize, letterSpacing: -0.3, color: colors.paper },
  body: { paddingTop: brand.top + 56, paddingHorizontal: brand.left },
  label: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginTop: 24 },
  multi: { height: undefined, minHeight: 96, paddingVertical: 12, lineHeight: 23, textAlignVertical: 'top' },
  choice: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.paper },
  choiceText: { flex: 1, fontFamily: fonts.regular, fontSize: 17, letterSpacing: -0.2, color: colors.paper },
  quiet: { color: colors.mute },
  pressed: { opacity: 0.6 },
  said: { fontFamily: fonts.regular, fontSize: 13, color: colors.paper, marginTop: 14 },
  bad: { color: colors.spotText },
  note: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.mute, marginTop: 14 },
});
