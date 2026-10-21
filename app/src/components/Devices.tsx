import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { fleet, linkPassport, passportQr, unlinkPassport, useLinked, type Passport } from '@/data/passport';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// Your devices (21.10.2026): this one and the ones connected by qr. Under the passport
// card: a box with one row per device (kind, name, rough speed, os, when measured) and
// the fleet under a rule: the best device's model (memory is not pooled), summed compute,
// bandwidth and disk, and what the fleet would make in one night. Two buttons: "show qr"
// draws this passport as a code for another device to read; "connect" opens the camera
// (or takes the json from the clipboard, for a computer or where there is no camera).
// The list lives on this phone only (data/passport.ts, linkedPassports).
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const two = (n: number) => String(n).padStart(2, '0');
const at = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

export default function Devices({ passport }: { passport: Passport | null }) {
  const { t, tn, tx, up } = useLang();
  const { width } = useWindowDimensions();
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
  const kind = (p: Passport) => tx(`devices.kind.${p.kind ?? 'phone'}`, t('devices.kind.phone'));

  return (
    <>
      <View style={styles.sec}>
        <Text style={styles.mono}>{up(t('devices.title'))}</Text>
        <Text style={styles.mono}>{up(f.count ? `${tn('devices.count', f.count)} · ${t('devices.together', { n: f.tps })}` : '')}</Text>
      </View>
      <View style={styles.box}>
        {passport ? <DeviceRow name={passport.device} kind={kind(passport)} tps={passport.est_tps} meta={`${passport.os ?? passport.android} · ${at(passport.measured_at)}`} tail={t('devices.this')} /> : null}
        {linked.map((l) => (
          <DeviceRow key={l.id} name={l.data.device} kind={kind(l.data)} tps={l.data.est_tps} meta={`${l.data.os ?? l.data.android} · ${at(l.data.measured_at)}${l.data.approx ? ` · ${t('devices.approx')}` : ''}`} tail={t('devices.remove')} onTail={() => unlinkPassport(l.id)} />
        ))}
        {linked.length ? (
          <>
            <View style={styles.rule} />
            <View style={styles.between}>
              <Text style={styles.k}>{t('devices.largest')}</Text>
              <Text style={styles.v}>{`${f.largest} Q4`}</Text>
            </View>
            <View style={styles.between}>
              <Text style={styles.k}>{`${t('passport.compute')} · ${t('passport.bw')} · ${t('passport.disk')}`}</Text>
              <Text style={styles.v}>{`${f.gflops} gflops · ${f.bw} gb/s · ${f.storage} gb`}</Text>
            </View>
            <Text style={styles.night}>{t('devices.night', { n: fmtTokens(f.tokens_night) })}</Text>
            <Text style={styles.small}>{t('devices.notPooled')}</Text>
          </>
        ) : (
          <Text style={styles.small}>{t('devices.empty')}</Text>
        )}
      </View>
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
          <Text style={styles.monoCenter}>{up(passport ? upperData(passport.device) : '')}</Text>
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

function DeviceRow({ name, kind, tps, meta, tail, onTail }: { name: string; kind: string; tps: number; meta: string; tail: string; onTail?: () => void }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <View style={styles.rowTop}>
          <Text style={styles.kind}>{kind.toUpperCase()}</Text>
          <Text style={styles.name} numberOfLines={1}>{name.toLowerCase()}</Text>
        </View>
        <Text style={styles.meta} numberOfLines={1}>{meta.toLowerCase()}</Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.tps}>{`${tps} tok/s`}</Text>
        {onTail ? (
          <Pressable onPress={onTail} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.meta, styles.link]}>{tail}</Text>
          </Pressable>
        ) : (
          <Text style={styles.meta}>{tail}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sec: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 22, marginBottom: 10, gap: 10 },
  mono: { flexShrink: 1, fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.4, color: colors.mute },
  monoCenter: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.4, color: colors.mute, textAlign: 'center' },
  box: { borderWidth: 1, borderColor: colors.ink3, borderRadius: radius.md, padding: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowRight: { alignItems: 'flex-end' },
  kind: { fontFamily: fonts.jet, fontSize: 9, letterSpacing: 1.2, color: colors.spotText },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.paper },
  tps: { fontFamily: fonts.jet, fontSize: 11, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.mute, marginTop: 2 },
  link: { textDecorationLine: 'underline', color: colors.paper },
  rule: { height: 1, backgroundColor: colors.rule, marginVertical: 2 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  k: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.mute },
  v: { fontFamily: fonts.jet, fontSize: 11, color: colors.paper, textAlign: 'right' },
  night: { fontFamily: fonts.logo, fontSize: 20, color: colors.paper, marginTop: 2 },
  small: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.meta },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
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
