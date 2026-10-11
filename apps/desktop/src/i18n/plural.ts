/*
 * CLDR plural categories, shared by three places that must agree: the message type
 * (which makes plural variants optional), the translator (which picks one by count),
 * and the copy checks in tests/unit/i18n.spec.ts.
 */
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/** A key that refines a plain message for one plural category, e.g. `…_few`. */
export type PluralVariantKey = `${string}_${PluralCategory}`;

/** Whether `key` refines a plain message with a plural category instead of being one. */
export function isPluralVariantKey(key: string): key is PluralVariantKey {
  return PLURAL_CATEGORIES.some((category) => key.endsWith(`_${category}`));
}

/** The variant key for a plain message and a CLDR category. */
export function pluralVariantKey(key: string, category: PluralCategory): string {
  return `${key}_${category}`;
}
