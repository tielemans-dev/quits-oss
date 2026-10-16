/**
 * Literal colours that cannot read a CSS custom property: the browser chrome colour and the dark
 * scheme of HTML email. `document-colors.ts` stays the light-theme authority.
 */

/** The hex of `--background` in `:root` and in `.dark` (see styles.css). */
export const THEME_CHROME_COLORS = { light: "#ffffff", dark: "#0f1019" } as const

/** Dark scheme for invoice email, where clients that honour `prefers-color-scheme` swap these in. */
export const EMAIL_DARK_COLORS = {
  paper: "#111112",
  panel: "#1a1b1e",
  ink: "#f2f2f0",
  muted: "#a6abb2",
  hairline: "#36383d",
} as const
