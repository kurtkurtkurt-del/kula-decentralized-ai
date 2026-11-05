import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppSize } from '@/hooks/useAppSize';
import { Image } from 'expo-image';
import { SvgUri } from 'react-native-svg';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BackButton from '@/components/BackButton';
import Button from '@/components/Button';
import NightNetwork from '@/components/NightNetwork';
import PullDownScroll from '@/components/PullDownScroll';
import ShareButton from '@/components/ShareButton';
import Tips from '@/components/Tips';
import { useAuth } from '@/auth/AuthContext';
import { aboutFor, samplesFor, type About, type Sample } from '@/data/about';
import { monthNights, useNightSummary } from '@/data/night';
import { fetchProject, peekProject, posterUrl, keepProject, type Project, type ProjectPage } from '@/data/projects';
import { OfflineError, useShelf } from '@/lib/offline';
import { shareProject } from '@/lib/share';
import { chooseTonight, recheck, tonightProject } from '@/night/useNight';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';


// The project page (the night page's layout): the poster, the title and the model, a
// perforated line, a stub with nights · phones · energy large, and the red action: work
// on it tonight. Under it keep and share, the numbers (phones in, nights done, tokens),
// who runs it (project_about), and what the model says (project_samples).
export default function ProjectScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useAppSize();
  const { session } = useAuth();
  const { t, tn, up, lang } = useLang();
  const [page, setPage] = useState<ProjectPage | null>(null);
  const [saved] = useState<Project | null>(() => (slug ? peekProject(slug) : null));
  const [missing, setMissing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [about, setAbout] = useState<About | null>(null);
  const [sample, setSample] = useState<Sample | null>(null);
  const [tonight, setTonight] = useState(() => tonightProject() === slug);
  const [broken, setBroken] = useState(false);
  const fresh = useShelf('projectPage');
  const nightRows = useNightSummary(session?.user.id);
  const myNights = slug ? monthNights(nightRows, slug) : 0;
  useEffect(() => {
    if (!slug) return;
    let live = true;
    fetchProject(slug)
      .then((p) => {
        if (!live) return;
        if (p) {
          setPage(p);
          setKept(p.kept);
          aboutFor([p.id], lang).then((m) => live && setAbout(m.get(p.id) ?? null));
          samplesFor([p.id], lang).then((m) => live && setSample(m.get(p.id) ?? null));
        } else setMissing(true);
      })
      .catch((e) => live && setNote(e instanceof OfflineError ? t('offline.empty') : String(e.message).toLowerCase()));
    return () => {
      live = false;
    };
  }, [slug, fresh, lang, t]);
  const p: Project | ProjectPage | null = page ?? saved;

  const keep = () => {
    if (!p) return;
    setKept(true);
    if (session) keepProject(p.slug).catch(() => {});
  };
  // "work on it tonight": the night worker picks this project when the conditions are met.
  const pickTonight = () => {
    if (!p) return;
    if (!kept) keep();
    chooseTonight(tonight ? null : p.slug);
    setTonight(!tonight);
    recheck().catch(() => {});
  };
  const poster = p && !p.image_url && !broken ? posterUrl(p) : null;
  const band = (
    <View style={styles.band}>
      <BackButton />
    </View>
  );
  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      {p ? (
        <PullDownScroll header={band} contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false}>
          <View style={styles.ticketWrap}>
            <View style={styles.ticket}>
              <View style={[styles.ticketPhoto, { height: (width - brand.left * 2) * 0.78 }]}>
                {p.image_url ? <Image source={{ uri: p.image_url }} style={styles.fill} contentFit="cover" /> : poster ? <SvgUri uri={poster} width="100%" height="100%" onError={() => setBroken(true)} /> : <NightNetwork seed={p.slug.length * 13 + (p.poster_no ?? 0)} />}
                <ShareButton onPress={() => shareProject(p)} style={styles.ticketShare} />
              </View>
              <View style={styles.ticketHead}>
                <Text style={styles.title}>{p.title.toLowerCase()}</Text>
                <Text style={styles.mono}>{upperData(p.model)} · {upperData(p.org)}{p.city_name ? ` · ${upperData(p.city_name)}` : ''}</Text>
              </View>
              <View style={styles.perf}>
                <View style={styles.perfLine} />
                <View style={[styles.notch, styles.notchLeft]} />
                <View style={[styles.notch, styles.notchRight]} />
              </View>
              <View style={styles.stub}>
                <Fact k={t('project.nightsWanted')} v={String(p.nights_wanted)} />
                <Fact k={t('project.phonesWanted')} v={String(p.phones_wanted)} />
                <Fact k={t('project.energy')} v={`${Math.round(Number(p.est_kwh))}`} unit={`kwh · ${Math.round(Number(p.est_eur))} €`} />
              </View>
              <View style={styles.stubAction}>
                <Button label={tonight ? t('project.tonight.set') : t('project.tonight')} kind={tonight ? 'line' : 'red'} onPress={pickTonight} />
                <Text style={styles.stubNote}>{up(t('night.sim'))}</Text>
              </View>
            </View>
          </View>

          <View style={styles.body}>
            <View style={styles.actions}>
              <View style={{ flex: 1 }}><Button label={kept ? t('project.kept') : t('word.keep')} kind="line" onPress={keep} /></View>
              <View style={{ flex: 1 }}><Button label={t('project.share')} kind="line" onPress={() => shareProject(p)} /></View>
            </View>
            {note ? <Text style={styles.mono}>{up(note)}</Text> : null}
            <Text style={styles.text}>{p.summary}</Text>
            {page ? (
              <Text style={styles.mono}>
                {up(`${t('project.phonesIn', { n: page.phones_in })} · ${t('project.nightsDone', { n: page.nights_done })} · ${t('project.tokens', { n: fmt(Number(page.tokens)) })}`)}
              </Text>
            ) : null}
            {myNights > 0 ? <Text style={styles.mono}>{up(t('project.nightsMonth', { n: myNights }))}</Text> : null}
            {page?.friends.length ? <Text style={[styles.mono, styles.red]}>{up(t('project.friends', { names: page.friends.join(', ') }))}</Text> : null}

            {about ? (
              <View style={styles.section}>
                <Text style={styles.mono}>{up(t('project.org'))}{about.kicker ? ` · ${up(about.kicker)}` : ''}</Text>
                <Text style={styles.text}>{about.who}</Text>
                {about.facts.length ? (
                  <View style={styles.facts}>
                    {about.facts.map((f, i) => (
                      <View key={i} style={styles.fact}>
                        <Text style={styles.factNo}>{String(i + 1).padStart(2, '0')}</Text>
                        <Text style={styles.factText}>{f}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {about.source_url ? (
                  <Pressable onPress={() => Linking.openURL(about.source_url!).catch(() => {})} hitSlop={8}>
                    <Text style={[styles.mono, styles.link]}>{up(t('about.source'))} ↗</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {sample ? (
              <View style={styles.section}>
                <Text style={styles.mono}>{up(t('sample.ask'))}</Text>
                <View style={styles.sample}>
                  <Text style={styles.samplePrompt}>{up(t('sample.prompt'))}: {sample.prompt}</Text>
                  {sample.lines.map((l, i) => (
                    <Text key={i} style={styles.sampleLine}>{l}</Text>
                  ))}
                </View>
              </View>
            ) : null}
            <Text style={styles.mono}>{up(tn('project.nightsFor', p.nights_wanted))} · {upperData(p.model)}</Text>
          </View>
        </PullDownScroll>
      ) : (
        <>
          {band}
          <View style={styles.centre}>
            <Text style={styles.mono}>{up(missing ? t('project.gone') : note ?? t('project.loading'))}</Text>
          </View>
        </>
      )}
      <Tips page="project" tip={{ title: 'tips.project.1.t', body: 'tips.project.1.b', motion: 'tap' }} bottom={insets.bottom + 84} />
    </View>
  );
}

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

function Fact({ k, v, unit }: { k: string; v: string; unit?: string }) {
  const { up } = useLang();
  return (
    <View style={styles.factBox}>
      <Text style={styles.factK}>{up(k)}</Text>
      <Text style={styles.factBig} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{v}</Text>
      {unit ? <Text style={styles.factNote}>{unit}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 36, zIndex: 2 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' },
  ticketWrap: { paddingHorizontal: brand.left, paddingTop: brand.top + 44 },
  ticket: { backgroundColor: colors.ink2, borderRadius: radius.lg, overflow: 'hidden' },
  ticketPhoto: { backgroundColor: colors.ink2, overflow: 'hidden' },
  ticketShare: { right: 12, top: 12, bottom: 'auto' },
  ticketHead: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, gap: 6 },
  perf: { height: 2, marginHorizontal: 12, justifyContent: 'center' },
  perfLine: { borderTopWidth: 2, borderStyle: 'dashed', borderColor: colors.ink3 },
  notch: { position: 'absolute', top: -9, width: 18, height: 18, borderRadius: 9, backgroundColor: colors.ink },
  notchLeft: { left: -21 },
  notchRight: { right: -21 },
  stub: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  factBox: { flex: 1, gap: 2 },
  factK: { fontFamily: fonts.jet, fontSize: 9, letterSpacing: 1.2, color: colors.mute },
  factBig: { fontFamily: fonts.logo, fontSize: 24, lineHeight: 26, letterSpacing: -0.5, color: colors.paper },
  factNote: { fontFamily: fonts.regular, fontSize: 10, color: colors.mute },
  stubAction: { padding: 12, paddingTop: 10, gap: 8 },
  stubNote: { fontFamily: fonts.jet, fontSize: 9, letterSpacing: 1.2, color: colors.mute, textAlign: 'center' },
  title: { fontFamily: fonts.logo, fontSize: 34, lineHeight: 34, letterSpacing: -0.9, color: colors.spotText },
  mono: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute },
  red: { color: colors.spotText },
  link: { textDecorationLine: 'underline', color: colors.paper },
  body: { paddingHorizontal: brand.left, paddingTop: 18, gap: 18 },
  actions: { flexDirection: 'row', gap: 10 },
  text: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 24, color: colors.paper2, opacity: 0.9 },
  section: { marginTop: 10, paddingTop: 18, borderTopWidth: 1, borderTopColor: colors.ink3, gap: 10 },
  facts: { gap: 8 },
  fact: { flexDirection: 'row', gap: 10 },
  factNo: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1, color: colors.spotText, paddingTop: 3 },
  factText: { flex: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.paper },
  sample: { backgroundColor: colors.paper, borderRadius: radius.md, padding: 14, gap: 6 },
  samplePrompt: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1, color: colors.ink2 },
  sampleLine: { fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: colors.ink },
});
