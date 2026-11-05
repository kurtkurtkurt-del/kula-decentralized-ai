import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { linkPassport } from '@/data/passport';
import { useLang } from '@/i18n';
import { classify, explain } from '@/llm/errors';
import { tapDone } from '@/lib/haptics';
import { isPeerQr, isRelayCode, parseRelayCode, takePeerQr } from '@/llm/peers';
import { rememberPeer, type Peer } from '@/llm/store';
import { fonts, radius } from '@/theme/tokens';

// Adding a device by its code, and the camera that reads it (6.11.2026: moved out of the
// peers page so the "run this together" flow scans the same way). A code is a peer qr (v2/v3,
// from "share this phone" or kula-node), a relay code ("123456 0123…", a device far away), or
// an old passport-only code, which still links the passport.
export function usePeerAdd(onAdded?: (p: Peer | null) => void) {
  const { t, tx } = useLang();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3000);
    return () => clearTimeout(id);
  }, [note]);

  const take = (text: string): boolean => {
    try {
      if (isRelayCode(text)) {
        const p = parseRelayCode(text);
        rememberPeer(p);
        setErr(null);
        setNote(t('peers.added', { name: p.name }));
        onAdded?.(p);
        return true;
      }
      if (!isPeerQr(text)) {
        linkPassport(text);
        setNote(t('devices.connected', { d: '' }));
        onAdded?.(null);
        return true;
      }
      const p = takePeerQr(text);
      setErr(null);
      tapDone();
      setNote(t('peers.added', { name: p.name.toLowerCase() }));
      onAdded?.(p);
      return true;
    } catch (e) {
      // the qr codes' own words first (notPeer · self · old), the dictionary for the rest
      const code = (e as Error).message;
      const own = tx(`peers.err.${code}`, tx(`devices.err.${code}`, ''));
      setErr(own || (classify(e).kind === 'unknown' ? t('peers.err.notPeer') : explain(e, tx)));
      return false;
    }
  };
  const paste = async () => take((await Clipboard.getStringAsync().catch(() => '')) ?? '');
  return { take, paste, err, setErr, note, setNote };
}

/** The full-screen camera; asks for the permission when it opens. onData returns whether the code was taken. */
export function ScanModal({ open, err, onClose, onData, onPaste }: { open: boolean; err: string | null; onClose: () => void; onData: (text: string) => boolean; onPaste: () => void }) {
  const { t } = useLang();
  const [perm, ask] = useCameraPermissions();
  const locked = useRef(false);
  const camera = Platform.OS !== 'web';
  useEffect(() => {
    if (!open) return;
    locked.current = false;
    if (!perm?.granted && perm?.canAskAgain !== false) ask().catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScan = ({ data }: { data: string }) => {
    if (locked.current) return;
    locked.current = true;
    if (!onData(data)) setTimeout(() => (locked.current = false), 1200);
  };
  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <View style={styles.scanRoot}>
        {camera && perm?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
        ) : (
          <View style={styles.center}>
            {camera && perm?.canAskAgain !== false ? (
              <Pressable onPress={() => ask().catch(() => {})} accessibilityRole="button" accessibilityLabel={t('devices.camera')} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('devices.camera')}</Text></Pressable>
            ) : (
              <Text style={styles.hint}>{t('devices.cameraOff')}</Text>
            )}
          </View>
        )}
        <View style={styles.frame} pointerEvents="none" />
        <View style={styles.bottom}>
          <Text style={styles.hint}>{err ?? t('devices.scanHint')}</Text>
          <View style={styles.actions}>
            <Pressable onPress={onPaste} accessibilityRole="button" accessibilityLabel={t('peers.paste')} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('peers.paste')}</Text></Pressable>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('word.close')} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('word.close')}</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scanRoot: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  frame: { position: 'absolute', top: '28%', left: '15%', right: '15%', aspectRatio: 1, borderWidth: 2, borderColor: '#fff', borderRadius: radius.md, opacity: 0.8 },
  bottom: { position: 'absolute', left: 24, right: 24, bottom: 48, gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  btn: { paddingHorizontal: 14, minHeight: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: '#fff', justifyContent: 'center' },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: '#fff' },
  hint: { fontFamily: fonts.regular, fontSize: 13, color: '#fff', textAlign: 'center' },
  pressed: { opacity: 0.7 },
});
