import { StyleSheet, Text, View } from 'react-native';
import StaffPage, { Quiet } from '@/components/StaffPage';
import { Panel, Row, Section, Value } from '@/components/Row';
import { accuracy, compare, useReports, type NightReport } from '@/night/report';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { useState } from 'react';

// The morning report (night-2): last night in numbers (units, checks right, tok/s per
// device, time worked, Wh at the measured or assumed wattage), against the nights before,
// and the earlier nights under it, each openable. The data is night/report.ts.
const two = (n: number) => String(n).padStart(2, '0');
const hm = (seconds: number) => `${Math.floor(seconds / 3600)}h ${two(Math.floor((seconds % 3600) / 60))}m`;
const at = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const signed = (n: number, unit = '') => `${n > 0 ? '+' : ''}${n}${unit}`;

export default function NightReportScreen() {
  const { t } = useLang();
  const all = useReports();
  const [picked, setPicked] = useState<string | null>(null);
  const r = (picked ? all.find((x) => x.id === picked) : null) ?? all.at(-1) ?? null;
  const previous = r ? all.filter((x) => x.id < r.id) : [];
  const cmp = r ? compare(r, previous) : null;
  const acc = r ? accuracy(r) : null;
  return (
    <StaffPage title={t('night.report')}>
      {!r ? <Quiet text={t('night.report.none')} /> : (
        <>
          <Text style={styles.date}>{`${r.id} · ${r.slug.replace(/-/g, ' ')} · ${at(r.startedAt)} – ${at(r.endedAt)}`}</Text>
          <View style={styles.grid}>
            <Tile big={String(r.units)} small={t('night.report.units')} />
            <Tile big={acc === null ? '—' : `${Math.round(acc * 100)} %`} small={acc === null ? t('night.report.nochecks') : `${r.checked - r.wrong}/${r.checked} ${t('night.report.right')}`} />
            <Tile big={`${r.tps}`} small="tok/s" />
            <Tile big={hm(r.seconds)} small={`${t('night.report.time')} · ${t('night.report.segments', { n: r.segments })}`} />
            <Tile big={`${r.wh} wh`} small={`${t('night.report.energy')} · ${t(r.measured ? 'night.report.watts.measured' : 'night.report.watts.assumed', { w: r.watts })}`} />
            <Tile big={r.model ?? '—'} small={r.real ? `${r.tokens} ${t('night.tokens')}` : t('night.sim')} />
          </View>

          <Section title={t('night.report.devices')} />
          <Panel>
            {r.devices.length ? r.devices.map((d) => <Row key={d.id} label={d.name} right={<Value text={`${d.units} · ${d.tps} tok/s`} />} />) : <Row label="—" />}
          </Panel>

          <Section title={cmp ? t('night.report.compare', { n: cmp.nights }) : t('night.report.first')} />
          {cmp ? (
            <Panel>
              <Row label={t('night.report.units')} right={<Value text={signed(cmp.units)} />} />
              <Row label="tok/s" right={<Value text={signed(cmp.tps)} />} />
              <Row label={t('night.report.time')} right={<Value text={signed(Math.round(cmp.seconds / 60), ' min')} />} />
              <Row label={t('night.report.energy')} right={<Value text={signed(cmp.wh, ' wh')} />} />
              {cmp.best ? <Row label={t('night.report.best')} /> : null}
            </Panel>
          ) : null}
          <Quiet text={t(r.sent ? 'night.report.sent' : 'night.report.unsent')} />

          {all.length > 1 ? (
            <>
              <Section title={t('night.report.past')} />
              <Panel>
                {[...all].reverse().map((x: NightReport) => (
                  <Row key={x.id} label={x.id} hint={x.slug.replace(/-/g, ' ')} onPress={() => setPicked(x.id)} right={<Value text={`${x.units} · ${x.tps} tok/s · ${x.wh} wh`} more={x.id !== r.id} />} />
                ))}
              </Panel>
            </>
          ) : null}
        </>
      )}
    </StaffPage>
  );
}

function Tile({ big, small }: { big: string; small: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.big} numberOfLines={1} adjustsFontSizeToFit>{big}</Text>
      <Text style={styles.small} numberOfLines={2}>{small}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  date: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.mute, marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  tile: { width: '47%', flexGrow: 1, borderWidth: 1, borderColor: colors.ink3, borderRadius: radius.md, padding: 12, gap: 4 },
  big: { fontFamily: fonts.semibold, fontSize: 22, color: colors.paper },
  small: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mute },
});
