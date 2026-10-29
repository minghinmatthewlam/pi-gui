/*
 * Locale-independent translation core: the registered catalogs plus a pure
 * translator. Kept free of React so non-component callers (and unit specs) can
 * translate without a tree.
 */
import { LOCALES, defaultLocale, type AppLocale, type MessageKey, type Messages } from "./catalog";
import { pluralVariantKey } from "./plural";

export type { AppLocale, LocaleDefinition, MessageKey, Messages } from "./catalog";

/** Values substituted into `{name}` placeholders in a message. */
export type TranslateParams = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: TranslateParams) => string;

/** Every registered locale's copy, by id. */
export const catalogs: Readonly<Record<AppLocale, Partial<Messages>>> = Object.fromEntries(
  LOCALES.map((locale) => [locale.id, locale.messages]),
) as Readonly<Record<AppLocale, Partial<Messages>>>;

const fallbackMessages: Partial<Messages> = catalogs[defaultLocale];

/** Replaces `{name}` placeholders; unknown names are left untouched rather than dropped. */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * One message for a catalog, walking the fallback chain: the locale's own copy,
 * then `defaultLocale`, then the key itself (which makes a missing string obvious
 * in the UI instead of rendering `undefined`).
 */
export function resolveMessage(catalog: Partial<Messages>, key: MessageKey): string {
  return catalog[key] ?? fallbackMessages[key] ?? key;
}

const pluralRulesByLocale = new Map<AppLocale, Intl.PluralRules>();

function pluralRulesFor(locale: AppLocale): Intl.PluralRules {
  const cached = pluralRulesByLocale.get(locale);
  if (cached) {
    return cached;
  }
  const rules = new Intl.PluralRules(locale);
  pluralRulesByLocale.set(locale, rules);
  return rules;
}

/**
 * The counted form of `key` for this locale, e.g. `composer.annotations_other`.
 * The categories come from CLDR (`Intl.PluralRules`), so a language with a `few`
 * or `many` form gets its own key instead of English's one/other split.
 *
 * The locale's own copy wins at every step — its plural form first, then its plain
 * message — so a language with a single plural category (Chinese, Japanese) can
 * translate the plain key alone and still read correctly at every count. When the
 * locale has no copy at all, English fills in with its own plural rules.
 */
function resolvePluralMessage(
  catalog: Partial<Messages>,
  key: MessageKey,
  locale: AppLocale,
  count: number,
): string | undefined {
  const variant = pluralVariantKey(key, pluralRulesFor(locale).select(count)) as keyof Messages;
  const own = catalog[variant] ?? catalog[key];
  if (own !== undefined) {
    return own;
  }
  // English copy takes English plural rules: Chinese reads every count as "other",
  // which would render "1 models".
  const fallbackVariant = pluralVariantKey(
    key,
    pluralRulesFor(defaultLocale).select(count),
  ) as keyof Messages;
  return fallbackMessages[fallbackVariant] ?? fallbackMessages[key];
}

/**
 * A translator bound to one locale. `catalog` defaults to the registered copy; specs
 * pass a smaller one to exercise the English fallback.
 */
export function translatorFor(
  locale: AppLocale,
  catalog: Partial<Messages> = catalogs[locale],
): Translate {
  return (key, params) => {
    const count = params?.count;
    if (typeof count === "number") {
      const plural = resolvePluralMessage(catalog, key, locale, count);
      if (plural !== undefined) {
        return interpolate(plural, params);
      }
    }
    return interpolate(resolveMessage(catalog, key), params);
  };
}

/** The default locale's translator, used wherever no locale is known. */
export const translate: Translate = translatorFor(defaultLocale);
