import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { saveSettings } from '@/data/settings';
import { loadProfile } from '@/data/profile';
import { getLang, known, remembered, setCurrentLang, translator, upper, type Lang, type Translator } from './core';

export { langNames, langs, upperData, type Lang } from './core';
export type { Key } from './dict';

type Value = Translator & { lang: Lang; setLang: (lang: Lang) => void; up: (text: string) => string };

const initial = getLang();
const Ctx = createContext<Value>({ ...translator(initial), lang: initial, setLang: () => {}, up: (text) => upper(text, initial) });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const uid = session?.user.id;
  const [lang, setState] = useState<Lang>(getLang);

  const setLang = useCallback(
    (next: Lang) => {
      setCurrentLang(next);
      setState(next);
      // Remember it on the account too: the website and new devices read it from there.
      if (uid) saveSettings({ locale: next }).catch(() => {});
    },
    [uid],
  );

  // Use the account's language if nothing was chosen on this device.
  useEffect(() => {
    if (!uid || remembered()) return;
    let live = true;
    (async () => {
      const settings = await loadProfile().catch(() => null);
      const theirs = known(settings?.locale);
      if (!live || !theirs || remembered()) return;
      setCurrentLang(theirs);
      setState(theirs);
    })();
    return () => {
      live = false;
    };
  }, [uid]);

  const value = useMemo(() => ({ ...translator(lang), lang, setLang, up: (text: string) => upper(text, lang) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// const { t, tn, tx, up, lang, setLang } = useLang();
export const useLang = () => useContext(Ctx);
// const t = useT();
export const useT = () => useContext(Ctx).t;
