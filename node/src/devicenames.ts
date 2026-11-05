// The name a person knows a device by (6.11.2026). Android reports Samsung phones by their
// model code ("SM-S936B", "SM_S936B", "samsung SM-S936B"); the box says "Galaxy S25+".
// The code's letter and three digits pick the model; the last letter is only the region
// (B europe, U usa, N korea…) and is ignored. Unknown codes stay as they are. A name the
// person typed (rename) always wins: this only fills in what nobody chose.

const SAMSUNG: Record<string, string> = {
  // galaxy s
  S901: 'Galaxy S22', S906: 'Galaxy S22+', S908: 'Galaxy S22 Ultra',
  S911: 'Galaxy S23', S916: 'Galaxy S23+', S918: 'Galaxy S23 Ultra', S711: 'Galaxy S23 FE',
  S921: 'Galaxy S24', S926: 'Galaxy S24+', S928: 'Galaxy S24 Ultra', S721: 'Galaxy S24 FE',
  S931: 'Galaxy S25', S936: 'Galaxy S25+', S938: 'Galaxy S25 Ultra', S937: 'Galaxy S25 Edge', S731: 'Galaxy S25 FE',
  // galaxy a
  A146: 'Galaxy A14 5G', A156: 'Galaxy A15 5G', A166: 'Galaxy A16 5G', A256: 'Galaxy A25', A266: 'Galaxy A26',
  A346: 'Galaxy A34', A356: 'Galaxy A35', A366: 'Galaxy A36', A536: 'Galaxy A53', A546: 'Galaxy A54', A556: 'Galaxy A55', A566: 'Galaxy A56',
  // galaxy z
  F936: 'Galaxy Z Fold4', F946: 'Galaxy Z Fold5', F956: 'Galaxy Z Fold6', F966: 'Galaxy Z Fold7',
  F721: 'Galaxy Z Flip4', F731: 'Galaxy Z Flip5', F741: 'Galaxy Z Flip6', F766: 'Galaxy Z Flip7',
  // galaxy tab
  X110: 'Galaxy Tab A9', X115: 'Galaxy Tab A9', X210: 'Galaxy Tab A9+', X216: 'Galaxy Tab A9+',
  X510: 'Galaxy Tab S9 FE', X516: 'Galaxy Tab S9 FE', X610: 'Galaxy Tab S9 FE+', X616: 'Galaxy Tab S9 FE+',
  X710: 'Galaxy Tab S9', X716: 'Galaxy Tab S9', X810: 'Galaxy Tab S9+', X816: 'Galaxy Tab S9+', X910: 'Galaxy Tab S9 Ultra', X916: 'Galaxy Tab S9 Ultra',
  X520: 'Galaxy Tab S10 FE', X526: 'Galaxy Tab S10 FE', X620: 'Galaxy Tab S10 FE+', X626: 'Galaxy Tab S10 FE+',
  X820: 'Galaxy Tab S10+', X826: 'Galaxy Tab S10+', X920: 'Galaxy Tab S10 Ultra', X926: 'Galaxy Tab S10 Ultra',
};

/** The public name for a reported device name, or the name itself when it is not a known code. */
export function publicName(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  const m = /(?:^|[\s_-])SM[\s_-]?([A-Z])(\d{3})[A-Z0-9]*\b/i.exec(s);
  if (m) {
    const known = SAMSUNG[`${m[1].toUpperCase()}${m[2]}`];
    if (known) return known;
  }
  return s;
}
