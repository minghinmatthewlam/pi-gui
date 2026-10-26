/**
 * Thinking levels a model accepts, lowest to highest.
 *
 * Mirrors pi's `getSupportedThinkingLevels` (packages/ai `models.ts`):
 * non-reasoning models expose only "off"; levels mapped to null are
 * dropped; xhigh/max additionally require a defined mapping. The
 * renderer offers exactly these levels so a selection never clamps
 * back down after being picked.
 */

const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface ThinkingLevelSource {
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Partial<Record<(typeof THINKING_LEVEL_ORDER)[number], string | null>>;
}

export function supportedThinkingLevels(model: ThinkingLevelSource): readonly string[] {
  if (!model.reasoning) {
    return ["off"];
  }
  return THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
}
