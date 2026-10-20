import { expect, test, vi } from 'vitest'
import { registerProductScenarios } from './scenarios.mjs'

vi.mock('node:fs/promises', () => ({
  readFile: async () => Buffer.from(`%PDF-${' '.repeat(1100)}%%EOF`),
}))

// In-memory Playwright protocol double. No browser, server or database is started.
function invoiceFixture(options, expected) {
  const journeys = new Map()
  const register = Object.assign((name, run) => journeys.set(name, run), { beforeEach() {} })
  let edited = false
  let taxValue = '0'
  const taxFills = []
  const controls = []
  const summaries = []
  const detailRates = []
  const listTotals = []
  const totals = () => edited ? expected.edited : expected.created
  const locator = (name, summary = false, detail = false) => ({
    name, summary, detail,
    getByText: text => locator(text, summary || name === 'Subtotal', detail || name === 'Subtotal excl. tax'),
    getByRole: role => locator(role, summary, detail),
    getByLabel: label => locator(label, summary, detail),
    locator: () => locator(name, summary || name === 'Subtotal', detail || name === 'Subtotal excl. tax'),
    filter: () => locator(name, summary, detail),
    nth: () => locator(name, summary, detail),
    last: () => locator(name, summary, detail),
    async click() {},
    async fill(value) {
      if (name === 'Qty' && value === '4') edited = true
      if (summary && name === 'spinbutton') {
        expect(expected.editable, 'fixed tax must never be filled').toBe(true)
        taxValue = value
        taxFills.push(value)
      }
    },
  })
  const page = {
    ...locator('page'),
    async goto() {},
    reload: vi.fn(),
    url: () => 'https://example.invalid/invoices/draft',
    waitForEvent: async () => ({ suggestedFilename: () => 'draft-invoice-invoice-customer-1.pdf', path: async () => '/mock/draft.pdf' }),
  }
  const assertions = target => {
    if (!target || typeof target !== 'object' || !('name' in target)) return expect(target)
    return {
      async toHaveURL() {},
      async toBeVisible() {},
      async toHaveAttribute() {},
      async toBeEditable() {
        expect(expected.editable).toBe(true)
      },
      async toHaveValue(value) {
        if (target.summary && target.name === 'spinbutton') {
          expect(value).toBe(String(expected.rate))
          expect(taxValue).toBe(value)
          controls.push('editable')
        }
      },
      async toHaveCount(count) {
        if (target.summary && target.name === 'spinbutton') {
          expect(expected.editable).toBe(false)
          expect(count).toBe(0)
          controls.push('fixed')
        }
      },
      async toHaveText() {},
      async toContainText(value) {
        const [subtotal, tax, total] = totals()
        if (target.summary) {
          const amounts = { Subtotal: subtotal, Tax: tax, Total: total }
          expect(value).toBe(amounts[target.name])
          summaries.push(value)
        } else if (target.detail) {
          const amounts = { 'Subtotal excl. tax': subtotal, [`Tax ${expected.rate}%`]: tax, 'Total incl. tax': total }
          expect(value).toBe(amounts[target.name])
          if (target.name.startsWith('Tax ')) detailRates.push(target.name)
        } else if (target.name === 'row' && value.startsWith('$')) {
          expect(value).toBe(total)
          listTotals.push(value)
        }
      },
    }
  }
  registerProductScenarios(register, assertions, options)
  return { journeys, page, taxFills, controls, summaries, detailRates, listTotals }
}

const policies = [
  { name: 'default editable 10%', options: undefined, rate: 10, editable: true,
    created: ['$499.50', '$49.95', '$549.45'], edited: ['$649.50', '$64.95', '$714.45'] },
  { name: 'fixed 25%', options: { invoiceTax: { ratePercent: 25, editable: false } }, rate: 25, editable: false,
    created: ['$499.50', '$124.88', '$624.38'], edited: ['$649.50', '$162.38', '$811.88'] },
  { name: 'custom editable 7.5%', options: { invoiceTax: { ratePercent: 7.5, editable: true } }, rate: 7.5, editable: true,
    created: ['$499.50', '$37.46', '$536.96'], edited: ['$649.50', '$48.71', '$698.21'] },
]

for (const policy of policies) {
  test.each([
    'creates a draft invoice with a calculated total and persists it',
    'edits a draft invoice and persists the recalculated total',
    'downloads a draft invoice PDF',
  ])(`${policy.name}: %s`, async name => {
    const fixture = invoiceFixture(policy.options, policy)
    await fixture.journeys.get(name)({ page: fixture.page, entryURL: 'https://example.invalid/' })
    const editing = name.startsWith('edits')
    const downloading = name.startsWith('downloads')
    expect(fixture.taxFills).toEqual(policy.editable ? [String(policy.rate)] : [])
    expect(fixture.controls).toEqual(Array(editing ? 2 : 1).fill(policy.editable ? 'editable' : 'fixed'))
    expect(fixture.summaries).toEqual([...policy.created, ...(editing ? policy.edited : [])])
    expect(fixture.detailRates).toEqual(downloading ? [] : [`Tax ${policy.rate}%`, `Tax ${policy.rate}%`])
    expect(fixture.listTotals).toEqual(!editing && !downloading ? [policy.created[2]] : [])
    expect(fixture.page.reload).toHaveBeenCalledTimes(downloading ? 0 : 1)
  })
}
