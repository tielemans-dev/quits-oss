/**
 * Full Stop colours for the surfaces that cannot read the CSS variables in styles.css: emails and
 * PDFs. The values are the light theme's, since a document is always shown on paper. Keep them in
 * step with styles.css.
 */
export const documentColors = {
  /** Text and the brand: ink. */
  ink: "#0b0b0c",
  /** The canvas behind a panel. */
  paper: "#fafaf9",
  panel: "#ffffff",
  /** Secondary body text. */
  body: "#3d4044",
  /** Labels and supporting text: graphite, 5.05:1 on white. */
  muted: "#6b6f76",
  /** Hairlines between rows. */
  hairline: "#e0e2e5",
  /** The heavier rule above a total. */
  rule: "#d0d2d4",
  /** Table headers and quiet panels. */
  fill: "#eeeff2",
  /** The green full stop. A fill or a rule, never text on a light surface. */
  settled: "#1fc16b",
  /** Settled green as text on a light surface (4.89:1 on white). */
  settledText: "#1e8149",
  /** The paid chip, under `tones.success`. */
  settledSoft: "#d1fbdc",
  /** Status tones as text colours, each with its badge tint (the tone at 14% over white). */
  tones: {
    neutral: { text: "#515458", tint: "#e7e7e8" },
    info: { text: "#3451c4", tint: "#e3e7f7" },
    success: { text: "#1c653a", tint: "#d1fbdc" },
    danger: { text: "#b42029", tint: "#f5e0e1" },
  },
} as const

/** The font stack for emails: Geist where the reader has it, the system face otherwise. */
export const EMAIL_FONT_STACK = "Geist,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
