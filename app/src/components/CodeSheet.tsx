import { useState } from 'react';
import { KeyboardAvoidingView, Modal, type KeyboardTypeOptions, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Button from '@/components/Button';
import Input from '@/components/Input';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand, MAX_WIDTH } from '@/theme/layout';

type Props = {
  open: boolean;
  title: string;
  go: string;
  error: string | null;
  onSubmit: (code: string) => void;
  onClose: () => void;
  // a password, an email address
  secure?: boolean;
  keyboardType?: KeyboardTypeOptions;
};

// Bottom sheet with one field: asks for a code. Same look as PickerSheet.
// Give it a key per request so the field starts empty each time.
export default function CodeSheet({ open, title, go, error, onSubmit, onClose, secure, keyboardType }: Props) {
  const insets = useSafeAreaInsets();
  const { up } = useLang();
  const [code, setCode] = useState('');
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.dim} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.head}>{up(title)}</Text>
          <Input value={code} onChangeText={setCode} autoFocus returnKeyType="done" onSubmitEditing={() => onSubmit(code)} secureTextEntry={secure} keyboardType={keyboardType} textContentType={secure ? 'newPassword' : keyboardType === 'email-address' ? 'emailAddress' : undefined} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.button}>
            <Button label={go} onPress={() => onSubmit(code)} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  dim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.6)' },
  sheet: { marginTop: 'auto', alignSelf: 'center', width: '100%', maxWidth: MAX_WIDTH, backgroundColor: colors.ink, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.ink3, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingHorizontal: brand.left, paddingTop: 12 },
  head: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginBottom: 6 },
  error: { fontFamily: fonts.regular, fontSize: 12, color: colors.spot, marginTop: 10 },
  button: { marginTop: 20 },
});
