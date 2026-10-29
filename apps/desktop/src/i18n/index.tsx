import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { defaultLocale, textDirectionFor, type AppLocale } from "./catalog";
import {
  LOCALE_STORAGE_KEY,
  detectSystemLanguages,
  readStoredLocale,
  resolveLocale,
  writeStoredLocale,
  type LocalePreference,
} from "./preference";
import { translate, translatorFor, type Translate } from "./translate";

export {
  LOCALES,
  appLocaleIds,
  defaultLocale,
  languageTagParts,
  localeDefinition,
  matchSystemLocale,
  textDirectionFor,
  type AppLocale,
  type LocaleDefinition,
  type MessageKey,
  type Messages,
} from "./catalog";
export {
  LOCALE_STORAGE_KEY,
  localePreferences,
  resolveLocale,
  type LocalePreference,
} from "./preference";
export {
  catalogs,
  interpolate,
  translate,
  translatorFor,
  type Translate,
  type TranslateParams,
} from "./translate";

interface I18nContextValue {
  readonly locale: AppLocale;
  /** What the user chose: a concrete locale, or "system". */
  readonly preference: LocalePreference;
  readonly setPreference: (preference: LocalePreference) => void;
  readonly t: Translate;
}

const fallbackValue: I18nContextValue = {
  locale: defaultLocale,
  preference: "system",
  setPreference: () => {},
  t: translate,
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  initialPreference,
}: {
  readonly children: ReactNode;
  /** Test seam: skip reading the profile so a spec can pin the locale. */
  readonly initialPreference?: LocalePreference;
}) {
  const [preference, setPreferenceState] = useState<LocalePreference>(
    () => initialPreference ?? readStoredLocale(),
  );
  const [systemLanguages, setSystemLanguages] = useState(detectSystemLanguages);
  const locale = useMemo(
    () => resolveLocale(preference, systemLanguages),
    [preference, systemLanguages],
  );

  useEffect(() => {
    // Every window keeps its own copy of the preference, so follow a choice made in
    // another window, and an OS language change while the preference is "system".
    const onStorage = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY) setPreferenceState(readStoredLocale());
    };
    const onLanguageChange = () => setSystemLanguages(detectSystemLanguages());
    window.addEventListener("storage", onStorage);
    window.addEventListener("languagechange", onLanguageChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("languagechange", onLanguageChange);
    };
  }, []);

  const setPreference = useCallback((next: LocalePreference) => {
    writeStoredLocale(next);
    setPreferenceState(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    // RTL locales set `dir` in the registry; everything else stays left-to-right.
    document.documentElement.dir = textDirectionFor(locale);
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, preference, setPreference, t: translatorFor(locale) }),
    [locale, preference, setPreference],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Falls back to the default locale so components stay renderable outside the provider. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? fallbackValue;
}

export function useTranslation(): { readonly t: Translate; readonly locale: AppLocale } {
  const { t, locale } = useI18n();
  return { t, locale };
}
