import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppSize } from '@/hooks/useAppSize';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { fleet, linkPassport, passportQr, rangeOf, rangeText, unlinkPassport, useLinked, type Passport } from '@/data/passport';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// Together (21.10.2026): one number — the tokens a second of this phone and the devices
// connected to it — a line per device, and two buttons: "show qr" draws this passport
// as a code for another phone to read, "connect" opens the camera (paste json inside
// it, for a computer or where there is no camera). The list lives on this phone only
// (data/passport.ts, linkedPassports). The speed adds up; the model is the best device's.
export default function Devices({ passport }: { passport: Passport | null }) {
  const { t, tn, tx, up } = useLang();
  const { width } = useAppSize();
  const linked = useLinked();
  const [qr, setQr] = useState(false);
  const [scan, setScan] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [perm, ask] = useCameraPermissions();
  const locked = useRef(false);
  const f = fleet(passport, linked);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3000);
    return () => clearTimeout(id);
  }, [note]);

  const take = (text: string) => {
    try {
      const p = linkPassport(text);
      setErr(null);
      setNote(t('devices.connected', { d: p.device.toLowerCase() }));
      setScan(false);
      return true;
    } catch (e) {
      setErr(tx(`devices.err.${(e as Error).message}`, t('devices.err.notPassport')));
      return false;
    }
  };
  const openScan = () => {
    setErr(null);
    locked.current = false;
    setScan(true);
    if (!perm?.granted && perm?.canAskAgain !== false) ask().catch(() => {});
  };
  const onScan = ({ data }: { data: string }) => {
    if (locked.current) return;
    locked.current = true;
    if (!take(data)) setTimeout(() => (locked.current = false), 1200);
  };
  const paste = async () => {
    const text = await Clipboard.getStringAsync().catch(() => '');
    take(text ?? '');
  };
  const camera = Platform.OS !== 'web';
  const all = [...(passport ? [{ id: 'me', data: passport }] : []), ...linked];

  return (
    <>
      <View style={styles.sec}>
        <Text style={styles.mono}>{up(t('devices.title'))}</Text>
      </View>
      <View style={styles.totalRow}>
        <Text style={[styles.total, f.tps_low !== f.tps_high && styles.totalRange]} numberOfLines={1} adjustsFontSizeToFit>{f.count ? rangeText(f.tps_low, f.tps_high) : '—'}</Text>
        <Text style={styles.unit}>tok/s</Text>
      </View>
      <Pressable onPress={() => router.push('/together')} hitSlop={8} accessibilityRole="link" style={({ pressed }) => [styles.open, pressed && styles.pressed]}>
        <Text style={styles.openText}>{t('combine.open')}</Text>
      </Pressable>
      <Text style={styles.under}>{f.count ? `${tn('devices.count', f.count)}${f.tps_low !== f.tps_high ? ` · ${t('passport.range')}` : ''} · ${t('devices.best', { model: f.largest })}` : t('devices.none')}</Text>
      {all.length ? (
        <View style={styles.list}>
          {all.map((l, i) => (
            <View key={l.id} style={[styles.row, i > 0 && styles.rowLine]}>
              <Text style={styles.name} numberOfLines={1}>{`${l.data.device} · ${l.data.os ?? l.data.android}`.toLowerCase()}</Text>
              <Text style={styles.tps}>{`${rangeText(rangeOf(l.data).low, rangeOf(l.data).high)} tok/s`}</Text>
              {l.id === 'me' ? (
                <Text style={styles.tail} numberOfLines={1}>{up(t('devices.this'))}</Text>
              ) : (
                <Pressable onPress={() => unlinkPassport(l.id)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('devices.remove')} style={styles.tail}>
                  <Text style={styles.x}>×</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.actions}>
        <Pressable onPress={() => passport && setQr(true)} disabled={!passport} style={({ pressed }) => [styles.btn, !passport && styles.off, pressed && styles.pressed]} accessibilityRole="button">
          <Text style={styles.btnText}>{t('devices.showQr')}</Text>
        </Pressable>
        <Pressable onPress={openScan} style={({ pressed }) => [styles.btn, pressed && styles.pressed]} accessibilityRole="button">
          <Text style={styles.btnText}>{t('devices.connect')}</Text>
        </Pressable>
      </View>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      {err && !scan ? <Text style={styles.note}>{err}</Text> : null}

      {/* this passport as a qr code, for the other device to read */}
      <Modal visible={qr} transparent animationType="fade" onRequestClose={() => setQr(false)}>
        <Pressable style={styles.dim} onPress={() => setQr(false)}>
          {passport ? (
            <View style={styles.qrPaper}>
              <QRCode value={passportQr(passport)} size={Math.min(width - 96, 300)} color={colors.paper} backgroundColor={colors.ink} ecl="M" />
            </View>
          ) : null}
          <Text style={styles.mono}>{up(passport ? upperData(passport.device) : '')}</Text>
          <Text style={styles.hint}>{t('devices.qrHint')}</Text>
        </Pressable>
      </Modal>

      {/* the camera: reads the other device's code; paste for computers and no camera */}
      <Modal visible={scan} animationType="slide" onRequestClose={() => setScan(false)}>
        <View style={styles.scanRoot}>
          {camera && perm?.granted ? (
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
          ) : (
            <View style={styles.center}>
              {camera && perm?.canAskAgain !== false ? (
                <Pressable onPress={() => ask().catch(() => {})} style={({ pressed }) => [styles.btn, styles.btnLight, pressed && styles.pressed]}>
                  <Text style={[styles.btnText, styles.btnTextLight]}>{t('devices.camera')}</Text>
                </Pressable>
              ) : (
                <Text style={styles.hintLight}>{t('devices.cameraOff')}</Text>
              )}
            </View>
          )}
          <View style={styles.frame} pointerEvents="none" />
          <View style={styles.scanBottom}>
            <Text style={styles.hintLight}>{err ?? t('devices.scanHint')}</Text>
            <View style={styles.actions}>
              <Pressable onPress={paste} style={({ pressed }) => [styles.btn, styles.btnLight, pressed && styles.pressed]} accessibilityRole="button">
                <Text style={[styles.btnText, styles.btnTextLight]}>{t('devices.paste')}</Text>
              </Pressable>
              <Pressable onPress={() => setScan(false)} style={({ pressed }) => [styles.btn, styles.btnLight, pressed && styles.pressed]} accessibilityRole="button">
                <Text style={[styles.btnText, styles.btnTextLight]}>{t('devices.close')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  sec: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 22, marginBottom: 6, gap: 10 },
  mono: { flexShrink: 1, fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.4, color: colors.mute },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  total: { fontFamily: fonts.logo, fontSize: 64, lineHeight: 68, letterSpacing: -2, color: colors.paper, flexShrink: 1 },
  open: { alignSelf: 'flex-start', marginBottom: 6 },
  openText: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText },
  totalRange: { fontSize: 46, lineHeight: 52, letterSpacing: -1.5 },
  unit: { fontFamily: fonts.regular, fontSize: 18, color: colors.mute },
  under: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute, marginTop: 2 },
  list: { marginTop: 16, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.ink3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  rowLine: { borderTopWidth: 1, borderColor: colors.ink3 },
  name: { flex: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.paper },
  tps: { fontFamily: fonts.jet, fontSize: 11, color: colors.paper },
  tail: { minWidth: 24, marginLeft: 10, alignItems: 'flex-end' }, // as wide as the tag; the device name gives way
  x: { fontFamily: fonts.regular, fontSize: 18, lineHeight: 20, color: colors.mute },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  btn: { flex: 1, height: 40, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  btnLight: { borderColor: '#FFFFFF' },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  btnTextLight: { color: '#FFFFFF' },
  off: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  note: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1, color: colors.mute, marginTop: 8 },
  dim: { flex: 1, backgroundColor: 'rgba(255,255,255,0.96)', alignItems: 'center', justifyContent: 'center', gap: 18, padding: 24 },
  qrPaper: { padding: 16, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink3, backgroundColor: colors.ink },
  hint: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.mute, textAlign: 'center' },
  scanRoot: { flex: 1, backgroundColor: '#000000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  frame: { position: 'absolute', left: '15%', right: '15%', top: '28%', aspectRatio: 1, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)', borderRadius: radius.md },
  scanBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 24, paddingBottom: 40, gap: 6, backgroundColor: 'rgba(0,0,0,0.55)' },
  hintLight: { fontFamily: fonts.regular, fontSize: 12.5, color: '#FFFFFF', textAlign: 'center' },
});
