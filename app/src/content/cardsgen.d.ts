// A night card's fields (data/contribution.ts toCardData fills them from a card row). The
// short names are the drawing's: t the project, ty the model, v who runs the project,
// d the date, in/out/dur the time worked, crew the faces who worked it (more: the rest),
// aud the tokens, msg the credits, who the energy, froze "NIGHT n", no the card number.
export type NightCardData = {
  city?: string;
  t: string; ty: string; v: string; d: string;
  metal: string; motif: string;
  in: string; out: string; dur: string;
  crew: string[]; more: number; aud: string; msg: number; who: string;
  froze: string; no: string;
  blank?: boolean; // still on its way: the slots are drawn, empty
};
declare const CARDS: {
  front: (e: NightCardData, i: number) => string;
  back: (e: NightCardData, i: number) => string;
};
export default CARDS;
