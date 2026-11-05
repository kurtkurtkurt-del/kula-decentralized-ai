// passportui strings (6.11.2026). Keys use the prefix 'passportui.'.
// The passport tab's lighter card: a front with the essentials, the full passport on its back.
export const passportui = {
  'passportui.open': { en: 'show the full passport', de: 'ganzen pass zeigen', tr: 'tüm pasaportu göster' },
  'passportui.close': { en: 'back to the front', de: 'zurück zur vorderseite', tr: 'ön yüze dön' },
  'passportui.back': { en: 'full passport', de: 'ganzer pass', tr: 'tüm pasaport' },
  'passportui.runs': { en: 'can run a model up to', de: 'schafft ein modell bis', tr: 'çalıştırabildiği model' },
  'passportui.ram': { en: 'ram', de: 'ram', tr: 'ram' },
  'passportui.speed': { en: 'tok/s', de: 'tok/s', tr: 'tok/s' },
  'passportui.compute': { en: 'gflops', de: 'gflops', tr: 'gflops' },
  'passportui.measured': { en: 'measured {at}', de: 'gemessen {at}', tr: 'ölçüm {at}' },
  'passportui.json.title': { en: 'the passport as a file', de: 'der pass als datei', tr: 'dosya olarak pasaport' },
  'passportui.json.text': {
    en: 'the same passport, written for machines. it shares what this device measured (memory, speed, the model it can hold) so the cluster can plan who runs what. nothing private: no name, no account, no files.',
    de: 'derselbe pass, für maschinen geschrieben. er teilt, was dieses gerät gemessen hat (speicher, tempo, welches modell passt), damit der verbund planen kann, wer was rechnet. nichts privates: kein name, kein konto, keine dateien.',
    tr: 'aynı pasaport, makineler için yazılmış hali. bu cihazın ölçülen gücünü (bellek, hız, sığan model) paylaşır, böylece küme kimin neyi çalıştıracağını planlar. özel bir şey yok: isim, hesap, dosya yok.',
  },
} as const;
