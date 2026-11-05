import { useEffect, useRef } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useLang } from '@/i18n';
import { radius, fonts } from '@/theme/tokens';

// The camera over the whole screen for another phone's share code, as the peers page has
// it (expo-camera, qr only), with paste beside it. `onCode` answers whether the code was
// taken; a refused one unlocks the scanner again after a moment, its reason in `err`.
type Props = { open: boolean; onClose: () => void; onCode: (text: string) => boolean; err: string | null };

export default function ScanSheet({ open, onClose, onCode, err }: Props) {
  const { t } = useLang();
  const [perm, ask] = useCameraPermissions();
  const locked = useRef(false);
  const camera = Platform.OS !== 'web';

  useEffect(() => {
    if (!open) return;
    locked.current = false;
    if (camera && !perm?.granted && perm?.canAskAgain !== false) ask().catch(() => {});
  }, [open, camera, perm?.granted, perm?.canAskAgain, ask]);

  const onScan = ({ data }: { data: string }) => {
    if (locked.current) return;
    locked.current = true;
    if (!onCode(data)) setTimeout(() => (locked.current = false), 1200);
  };
  const paste = async () => onCode((await Clipboard.getStringAsync().catch(() => '')) ?? '');

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <View style={s.root}>
        {camera && perm?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
        ) : (
          <View style={s.center}>
            {camera && perm?.canAskAgain !== false ? (
              <Pressable onPress={() => ask().catch(() => {})} accessibilityRole="button" accessibilityLabel={t('devices.camera')} style={({ pressed }) => [s.btn, pressed && s.pressed]}><Text style={s.btnText}>{t('devices.camera')}</Text></Pressable>
            ) : (
              <Text style={s.hint}>{t('devices.cameraOff')}</Text>
            )}
          </View>
        )}
        <View style={s.frame} pointerEvents="none" />
        <View style={s.top} pointerEvents="none">
          <Text style={s.kicker}>{t('power.scan.title')}</Text>
        </View>
        <View style={s.bottom}>
          <Text style={s.hint} accessibilityLiveRegion="polite">{err ?? t('power.scan.hint')}</Text>
          <View style={s.actions}>
            <Pressable onPress={paste} accessibilityRole="button" accessibilityLabel={t('peers.paste')} style={({ pressed }) => [s.btn, pressed && s.pressed]}><Text style={s.btnText}>{t('peers.paste')}</Text></Pressable>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('word.close')} style={({ pressed }) => [s.btn, pressed && s.pressed]}><Text style={s.btnText}>{t('word.close')}</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  frame: { position: 'absolute', top: '28%', left: '15%', right: '15%', aspectRatio: 1, borderWidth: 2, borderColor: '#fff', borderRadius: radius.md, opacity: 0.8 },
  top: { position: 'absolute', top: 64, left: 24, right: 24, alignItems: 'center' },
  kicker: { fontFamily: fonts.medium, fontSize: 15, color: '#fff', textAlign: 'center' },
  bottom: { position: 'absolute', left: 24, right: 24, bottom: 48, gap: 10 },
  hint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: '#fff', textAlign: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  btn: { paddingHorizontal: 16, minHeight: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: '#fff', justifyContent: 'center' },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: '#fff' },
  pressed: { opacity: 0.7 },
});
