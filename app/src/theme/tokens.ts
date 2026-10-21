import Storage from 'expo-sqlite/kv-store';

// The accent: red by default, picked in settings → app. spot fills (buttons, the dot,
// live rings), spotText is the same colour readable as small text on ink, rgb feeds
// the see-through tints. Read once at start: every StyleSheet below is built from it,
// so a new pick reloads the app (data/accent.ts).
// kula (21.10.2026): the "Berlin Analog" palette of the kula web app — terracotta is
// the default accent, sage the green, gold the warm one.
export const ACCENTS = {
  red: { spot: '#C86A51', spotText: '#B85A42', rgb: '200,106,81' },
  green: { spot: '#5B6B56', spotText: '#4E5D4A', rgb: '91,107,86' },
  yellow: { spot: '#D4A373', spotText: '#B08456', rgb: '212,163,115' },
  blue: { spot: '#4A6B53', spotText: '#3E5A46', rgb: '74,107,83' },
  pink: { spot: '#C87A53', spotText: '#A86340', rgb: '200,122,83' },
} as const;
export type AccentId = keyof typeof ACCENTS;
const readAccent = (): AccentId => {
  try {
    const v = Storage.getItemSync('accent');
    return v && v in ACCENTS ? (v as AccentId) : 'red';
  } catch {
    return 'red';
  }
};
export const accentId: AccentId = readAccent();
const accent = ACCENTS[accentId];
// A see-through version of the accent: tint(0.12) → 'rgba(…,0.12)'.
export const tint = (alpha: number) => `rgba(${accent.rgb},${alpha})`;

// White, with colours on top (20.10.2026: it was ink on paper, as afterhours). The names
// stayed so the screens did not: `ink` is the page's ground and `paper` the words on it.
export const colors = {
  paper: '#4E3629',          // the words: kula's deep brown
  paper2: '#6B4F3F',
  ink: '#F5F5F0',            // the ground: kula's warm off-white
  ink2: '#FAF7F0',           // blocks, cards: cream
  rule: '#D9D0C0',
  spot: accent.spot,         // the accent: live · kept · on; fills, borders, the dot in the logo
  spotText: accent.spotText, // accent TEXT on the warm ground
  ink3: '#EADFC9',           // hairline: dividers, borders
  mute: '#8C6F55',           // muted text and icons
  meta: '#B08F65',           // small uppercase meta lines
  // the colours on top: one per kind of thing
  gold: '#D4A373',           // calls
  blue: '#4A6B53',           // coops (kula has no blue: the deeper sage)
  green: '#5B6B56',          // the night running: sage
  violet: '#C86A51',         // terracotta where violet was
} as const;

// Corner radii: small squares (initials, marks) xs · inner buttons, chips sm ·
// buttons, panels, cards md · bottom sheets, large cards lg · pill buttons pill.
export const radius = {
  xs: 5,
  sm: 9,
  md: 14,
  lg: 24,
  pill: 999,
} as const;

export const fonts = {
  regular: 'InterTight_400Regular',
  medium: 'InterTight_500Medium',
  semibold: 'InterTight_600SemiBold',
  jet: 'JetBrainsMono_400Regular',  // mono details: poster captions, the map card (10–11 px)
  mono: 'InterTight_400Regular',    // small uppercase lines use the same family
  logo: 'ArchivoLogo',              // the name only: Archivo, width 62, weight 900 (assets/fonts)
} as const;

// Intro timing, ms.
export const intro = {
  hold: 300,       // paper holds empty
  photoIn: 1400,   // photo fades in
  wordDelay: 900,  // name starts to appear
  word: 800,       // name fade duration
  leaveAt: 3200,   // move to the next screen
} as const;
