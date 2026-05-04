/* Color theme presets for the desktop bubble.
 *
 * Each theme is a flat bag of CSS custom property values keyed without the
 * leading "--". The renderer applies them by setting the variables on
 * document.documentElement, so swapping a theme is a mechanical key→value
 * loop — no per-theme branching elsewhere.
 *
 * Constraints that hold across all four themes:
 *   - approve  ⇢ --accent-sage  (always greenish)
 *   - deny     ⇢ --accent-rose  (always reddish)
 *   - --ink-0 over --surface-1 ≥ WCAG AA (4.5:1) for the light theme,
 *     and ≥ 7:1 for the three dark themes.
 *
 * See docs/design-language.md for the original token rationale.
 */

const THEMES = [
  {
    id: "midnight-teal",
    displayName: "Midnight Teal",
    displayNameZh: "深海青夜",
    description: "Cool dusk surfaces with a teal accent — the polished default.",
    colorScheme: "dark",
    vars: {
      "bg":                        "oklch(13% 0.012 270)",
      "surface-1":                 "oklch(17% 0.014 270 / 0.96)",
      "surface-2":                 "oklch(22% 0.016 270)",
      "surface-3":                 "oklch(26% 0.018 270)",
      "inner-well":                "oklch(11% 0.010 270)",
      "ink-0":                     "oklch(95% 0.014 80)",
      "ink-1":                     "oklch(70% 0.012 250)",
      "ink-2":                     "oklch(50% 0.010 250)",
      "line":                      "oklch(60% 0 0 / 0.10)",
      "accent":                    "oklch(74% 0.07 195)",
      "accent-warm":               "oklch(78% 0.08 70)",
      "accent-warm-hi":            "oklch(82% 0.10 70)",
      "accent-sage":               "oklch(72% 0.06 150)",
      "accent-rose":               "oklch(70% 0.07 25)",
      "accent-slate":              "oklch(60% 0.03 250)",
      "shadow-inner-highlight":
        "0 1px 0 inset oklch(100% 0 0 / 0.055), 0 -1px 0 inset oklch(0% 0 0 / 0.18), 0 0 0 1px inset oklch(100% 0 0 / 0.045)",
      "context-color":             "oklch(74% 0.07 195)"
    }
  },
  {
    id: "amber-hearth",
    displayName: "Amber Hearth",
    displayNameZh: "暖夜炉火",
    description: "Warm browns and amber — easy on the eyes after sundown.",
    colorScheme: "dark",
    vars: {
      "bg":                        "oklch(15% 0.014 50)",
      "surface-1":                 "oklch(19% 0.018 50 / 0.96)",
      "surface-2":                 "oklch(24% 0.022 50)",
      "surface-3":                 "oklch(28% 0.026 50)",
      "inner-well":                "oklch(13% 0.012 50)",
      "ink-0":                     "oklch(94% 0.022 85)",
      "ink-1":                     "oklch(72% 0.020 70)",
      "ink-2":                     "oklch(52% 0.018 60)",
      "line":                      "oklch(70% 0.020 60 / 0.12)",
      "accent":                    "oklch(78% 0.10 65)",
      "accent-warm":               "oklch(80% 0.12 55)",
      "accent-warm-hi":            "oklch(85% 0.14 60)",
      "accent-sage":               "oklch(74% 0.08 145)",
      "accent-rose":               "oklch(70% 0.10 28)",
      "accent-slate":              "oklch(62% 0.025 70)",
      "shadow-inner-highlight":
        "0 1px 0 inset oklch(100% 0.020 80 / 0.06), 0 -1px 0 inset oklch(0% 0 0 / 0.22), 0 0 0 1px inset oklch(100% 0.020 80 / 0.05)",
      "context-color":             "oklch(78% 0.10 65)"
    }
  },
  {
    id: "paper-light",
    displayName: "Paper Light",
    displayNameZh: "晨纸轻亮",
    description: "White surfaces, slate ink, calm accents — daytime use.",
    colorScheme: "light",
    vars: {
      "bg":                        "oklch(99% 0.004 95)",
      "surface-1":                 "oklch(98% 0.004 95 / 0.98)",
      "surface-2":                 "oklch(95% 0.006 95)",
      "surface-3":                 "oklch(91% 0.008 95)",
      "inner-well":                "oklch(93% 0.006 95)",
      "ink-0":                     "oklch(19% 0.018 270)",
      "ink-1":                     "oklch(42% 0.018 260)",
      "ink-2":                     "oklch(58% 0.014 260)",
      "line":                      "oklch(20% 0.010 270 / 0.12)",
      "accent":                    "oklch(52% 0.10 200)",
      "accent-warm":               "oklch(58% 0.12 60)",
      "accent-warm-hi":            "oklch(62% 0.14 55)",
      "accent-sage":               "oklch(50% 0.10 150)",
      "accent-rose":               "oklch(54% 0.14 25)",
      "accent-slate":              "oklch(48% 0.04 250)",
      "shadow-inner-highlight":
        "0 1px 0 inset oklch(100% 0 0 / 0.85), 0 -1px 0 inset oklch(20% 0.010 270 / 0.06), 0 0 0 1px inset oklch(20% 0.010 270 / 0.05)",
      "context-color":             "oklch(52% 0.10 200)"
    }
  },
  {
    id: "aurora-indigo",
    displayName: "Aurora Indigo",
    displayNameZh: "极光紫夜",
    description: "Deep indigo surfaces with lavender + peach — bold and cinematic.",
    colorScheme: "dark",
    vars: {
      "bg":                        "oklch(14% 0.026 280)",
      "surface-1":                 "oklch(18% 0.032 280 / 0.96)",
      "surface-2":                 "oklch(23% 0.038 280)",
      "surface-3":                 "oklch(28% 0.044 285)",
      "inner-well":                "oklch(12% 0.024 280)",
      "ink-0":                     "oklch(94% 0.018 280)",
      "ink-1":                     "oklch(72% 0.026 285)",
      "ink-2":                     "oklch(52% 0.024 280)",
      "line":                      "oklch(80% 0.030 285 / 0.12)",
      "accent":                    "oklch(76% 0.10 290)",
      "accent-warm":               "oklch(80% 0.10 35)",
      "accent-warm-hi":            "oklch(84% 0.12 35)",
      "accent-sage":               "oklch(74% 0.08 160)",
      "accent-rose":               "oklch(72% 0.09 15)",
      "accent-slate":              "oklch(62% 0.04 280)",
      "shadow-inner-highlight":
        "0 1px 0 inset oklch(100% 0.020 290 / 0.07), 0 -1px 0 inset oklch(0% 0 0 / 0.22), 0 0 0 1px inset oklch(100% 0.020 290 / 0.05)",
      "context-color":             "oklch(76% 0.10 290)"
    }
  }
];

const DEFAULT_THEME_ID = "midnight-teal";

if (typeof module !== "undefined" && module.exports) {
  module.exports = { THEMES, DEFAULT_THEME_ID };
}
if (typeof window !== "undefined") {
  window.CCC_THEMES = { THEMES, DEFAULT_THEME_ID };
}
