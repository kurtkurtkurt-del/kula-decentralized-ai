// The name: large and centred in the intro, small top left on later screens.
export const brand = {
  bigSize: 30,
  smallSize: 18,
  top: 72,     // top margin of the small name
  left: 24,    // left margin of the small name
  move: 600,   // centre-to-corner slide duration, ms
  logoBig: 46,   // logo (Archivo condensed, black), centred in the intro
  logoSmall: 24, // logo, top left on the home screen
} as const;

// The widest the app gets: on a tablet it is a centred column of this width (22.10.2026).
export const MAX_WIDTH = 720; // 6.11.2026: 600 → 720 for the galaxy tab s10 fe (about 800 dp wide upright)
