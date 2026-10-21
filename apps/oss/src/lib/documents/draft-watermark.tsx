import { G, Path, Svg, View } from "@react-pdf/renderer"
import { documentColors as C } from "../brand/document-colors"

// The watermark is drawn as strokes, not text. Text drawn diagonally over the page ends up in the
// PDF's text layer, and extractors (copy-paste, screen readers, pdftotext) splice its letters into
// the lines it crosses. The banner already says the document is a draft in words.

/** Stroke outlines on a 100-unit cap height, y pointing down, for the letters of `pdf.draft.watermark`. */
export const draftWatermarkGlyphs: Record<string, { width: number; d: string }> = {
  A: { width: 64, d: "M0 100 L32 0 L64 100 M11 66 H53" },
  D: { width: 62, d: "M0 0 V100 H24 C50 100 62 80 62 50 C62 20 50 0 24 0 Z" },
  E: { width: 56, d: "M56 0 H0 V100 H56 M0 50 H48" },
  F: { width: 56, d: "M56 0 H0 V100 M0 50 H48" },
  K: { width: 60, d: "M0 0 V100 M60 0 L0 58 M20 40 L62 100" },
  L: { width: 54, d: "M0 0 V100 H54" },
  R: { width: 60, d: "M0 100 V0 H30 C50 0 58 12 58 28 C58 44 50 56 30 56 H0 M28 56 L60 100" },
  T: { width: 64, d: "M0 0 H64 M32 0 V100" },
}

const gap = 34
const scale = 0.86
const size = 520

export function DraftWatermark({ word }: { word: string }) {
  const glyphs = [...word].map(letter => draftWatermarkGlyphs[letter]).filter(glyph => glyph !== undefined)
  const width = glyphs.reduce((sum, glyph) => sum + glyph.width, 0) + gap * (glyphs.length - 1)
  let x = 0
  return (
    <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" }} fixed>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <G transform={`translate(${size / 2} ${size / 2}) rotate(-40) scale(${scale}) translate(${-width / 2} -50)`}>
          {glyphs.map((glyph, index) => {
            const path = (
              <Path key={index} d={glyph.d} transform={`translate(${x} 0)`} fill="none" stroke={C.tones.danger.text}
                strokeOpacity={0.12} strokeWidth={18} strokeLinecap="round" strokeLinejoin="round" />
            )
            x += glyph.width + gap
            return path
          })}
        </G>
      </Svg>
    </View>
  )
}
