import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDesign } from '../design-check.mjs'

test('reports off-scale document values with source lines', () => {
  const findings = checkDesign('fontSize: 22\nfontWeight: 600\npaddingTop: 3\ncolor: "#123456"\nfontFamily: "Helvetica"', 'email.ts')
  assert.deepEqual(findings.map(({ line, rule }) => [line, rule]), [[1, 'font-size'], [2, 'font-weight'], [3, 'spacing'], [4, 'one-off-value'], [5, 'pdf-font']])
  assert.ok(findings.every(finding => finding.file === 'email.ts'))
})
test('accepts approved scales, colour tokens and grid templates', () => {
  assert.deepEqual(checkDesign('fontSize: 24; fontWeight: 700; paddingTop: 48; color: C.ink; grid-cols-[1fr_2fr]', 'pdf.tsx'), [])
})
test('finds CSS email values and arbitrary Tailwind values', () => {
  const findings = checkDesign('font-size:22px; font-weight:600; text-[13px] bg-[#123456]', 'email.ts')
  assert.ok(findings.some(finding => finding.rule === 'font-size'))
  assert.ok(findings.some(finding => finding.rule === 'font-weight'))
  assert.ok(findings.some(finding => finding.value === 'text-[13px]'))
})
test('reports open Tailwind categories without flagging theme palette declarations', () => {
  assert.equal(checkDesign('@theme { --color-*: initial; --color-ink: #123456; }', 'styles.css').length, 5)
  assert.deepEqual(checkDesign('borderRadius: 8', 'card.tsx'), [])
  assert.equal(checkDesign('borderRadius: 3', 'card.tsx')[0].rule, 'radius')
})
