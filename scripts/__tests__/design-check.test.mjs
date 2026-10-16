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
test('lets token-built backgrounds through and does not read top-[50%] as p-[50%]', () => {
  const source = 'top-[50%] -top-[12vh] bg-[length:100%_1px] bg-[color-mix(in_srgb,var(--panel),var(--foreground)_4%)]'
  assert.deepEqual(checkDesign(source, 'card.tsx'), [])
  assert.deepEqual(checkDesign('-mt-[7px] sm:p-[50%]', 'card.tsx').map(({ value }) => value), ['mt-[7px]', 'p-[50%]'])
})
test('uses the app scale while retaining document and email scales', () => {
  assert.deepEqual(checkDesign('fontSize: 32; fontWeight: 500; borderRadius: 16', 'card.tsx'), [])
  assert.deepEqual(checkDesign('fontSize: 18; fontSize: 30; fontWeight: 700; fontWeight: 800; borderRadius: 6; borderRadius: 10', 'card.tsx').map(f => f.rule), ['font-size', 'font-size', 'font-weight', 'font-weight', 'radius', 'radius'])
  for (const file of ['lib/invoice-pdf.tsx', 'lib/emails/reminder-email.ts']) {
    assert.deepEqual(checkDesign('fontSize: 18; fontSize: 30; fontWeight: 700; borderRadius: 6; borderRadius: 10', file), [])
  }
})
