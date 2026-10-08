import { readFile } from 'node:fs/promises'

const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The 15th of next month in UTC: the calendar button label and how the detail page prints it. */
function nextMonthDue() {
  const now = new Date()
  const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15))
  const part = (options) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(due)
  return {
    calendarLabel: new RegExp(`${part({ month: 'long' })} 15th, ${due.getUTCFullYear()}`),
    detailText: part({ year: 'numeric', month: 'long', day: 'numeric' }),
  }
}

/**
 * Browser-only journeys. The consuming repository supplies the account fixture,
 * entry URL, and its own Playwright instance. No application or database imports.
 * @param {import('@playwright/test').TestType<import('@playwright/test').PlaywrightTestArgs & { account: { email: string, password: string }, entryURL: string }, import('@playwright/test').PlaywrightWorkerArgs>} test
 * @param {typeof import('@playwright/test').expect} expect
 */
export function registerProductScenarios(test, expect) {
  async function createContact(page, entryURL, name) {
    await page.goto(new URL('/contacts/new', entryURL).href)
    await page.getByLabel('Name *', { exact: true }).fill(name)
    await page.getByLabel('Email', { exact: true }).fill('customer@example.invalid')
    await page.getByRole('button', { name: 'Create Contact', exact: true }).click()
    await expect(page).toHaveURL(new URL('/contacts', entryURL).href)
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible()
  }

  /** Reads the line-item grid row `index`; the inputs have no labels, so scope by the description box. */
  const lineRow = (page, index) => page.getByPlaceholder('Description', { exact: true }).nth(index).locator('xpath=..')

  /** Summary block under the line items, shared by the new and edit forms. */
  const summaryOf = (page) => page.getByText('Subtotal', { exact: true }).locator('xpath=../..')

  async function expectSummary(page, { subtotal, tax, total }) {
    const summary = summaryOf(page)
    await expect(summary.getByText('Subtotal', { exact: true }).locator('xpath=..')).toContainText(usd(subtotal))
    await expect(summary.getByText('Tax', { exact: true }).locator('xpath=..').locator('span').last()).toContainText(usd(tax))
    await expect(summary.getByText('Total', { exact: true }).locator('xpath=..')).toContainText(usd(total))
  }

  /**
   * Fills the new-invoice form and saves it as a draft. Lines are
   * `{ description, quantity, unitPriceCents }`. Totals are computed in cents so the
   * live summary is verified before saving.
   */
  async function createDraftInvoice(page, entryURL, { customer, lines, taxPercent, notes }) {
    await page.goto(new URL('/invoices/new', entryURL).href)
    const contactSelect = page.getByRole('combobox').filter({ hasText: 'Select a contact' })
    // Contacts load after hydration, so a visible select means the form is interactive.
    await expect(contactSelect).toBeVisible()
    await contactSelect.click()
    await page.getByRole('option', { name: customer, exact: true }).click()

    const due = nextMonthDue()
    await page.getByLabel('Due Date *', { exact: true }).click()
    await page.getByRole('button', { name: /next month/i }).click()
    await page.getByRole('grid').getByRole('button', { name: due.calendarLabel }).click()

    for (const [index, line] of lines.entries()) {
      if (index > 0) await page.getByRole('button', { name: 'Add Item', exact: true }).click()
      const row = lineRow(page, index)
      await row.getByPlaceholder('Description', { exact: true }).fill(line.description)
      await row.getByRole('spinbutton').nth(0).fill(String(line.quantity))
      await row.getByRole('spinbutton').nth(1).fill((line.unitPriceCents / 100).toFixed(2))
    }
    await summaryOf(page).getByRole('spinbutton').fill(String(taxPercent))
    const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0)
    const tax = Math.round((subtotal * taxPercent) / 100)
    const totals = { subtotal, tax, total: subtotal + tax }
    await expectSummary(page, totals)
    if (notes) await page.getByLabel('Notes', { exact: true }).fill(notes)

    await page.getByRole('button', { name: 'Save as Draft', exact: true }).click()
    // A draft has no number yet: it is numbered when it is sent. The page names it a draft invoice.
    await expect(page.getByRole('heading', { level: 1, name: 'Draft invoice', exact: true })).toBeVisible()
    return { url: page.url(), due, ...totals }
  }

  async function expectInvoiceDetail(page, { customer, lines, total, subtotal, tax, taxPercent, status = 'Draft' }) {
    await expect(page.getByRole('heading', { level: 1, name: 'Draft invoice', exact: true })).toBeVisible()
    await expect(page.getByText(status, { exact: true })).toBeVisible()
    await expect(page.getByText(customer, { exact: true })).toBeVisible()
    // The organization's prices exclude tax, so the lines state net amounts that add up to the subtotal.
    await expect(page.getByRole('columnheader', { name: 'Unit Price excl. tax', exact: true })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Amount excl. tax', exact: true })).toBeVisible()
    for (const line of lines) {
      const row = page.getByRole('row').filter({ hasText: line.description })
      await expect(row).toBeVisible()
      await expect(row.getByRole('cell').nth(1)).toHaveText(String(line.quantity))
      await expect(row.getByRole('cell').nth(2)).toHaveText(usd(line.unitPriceCents))
      await expect(row.getByRole('cell').nth(3)).toHaveText(usd(line.quantity * line.unitPriceCents))
    }
    // The table header also says "Total", so scope to the block that holds the subtotal.
    const totals = summaryOf(page)
    await expect(totals.getByText('Subtotal', { exact: true }).locator('xpath=..')).toContainText(usd(subtotal))
    await expect(totals.getByText(`Tax (${taxPercent}%)`, { exact: true }).locator('xpath=..')).toContainText(usd(tax))
    await expect(totals.getByText('Total', { exact: true }).locator('xpath=..')).toContainText(usd(total))
  }

  const draft = (stamp) => ({
    customer: `Invoice customer ${stamp}`,
    lines: [
      { description: `Consulting ${stamp}`, quantity: 3, unitPriceCents: 15000 },
      { description: `Hosting ${stamp}`, quantity: 1, unitPriceCents: 4950 },
    ],
    taxPercent: 10,
    notes: `Thanks ${stamp}`,
  })

  test.beforeEach(async ({ page, account, entryURL }) => {
    await page.goto(entryURL)
    await expect(page).toHaveURL(/\/login(?:\?|$)/)
    await page.getByLabel('Email', { exact: true }).fill(account.email)
    await page.getByLabel('Password', { exact: true }).fill(account.password)
    // Shared loopback clients can hit the auth service's per-IP limit. Retry only
    // an explicit 429; authentication errors still fail immediately.
    for (let attempt = 0; ; attempt++) {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/sign-in/email' && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      const response = await pending
      if (response.status() !== 429 || attempt === 2) {
        expect(response.ok(), `Browser sign-in returned ${response.status()}`).toBeTruthy()
        break
      }
      const seconds = Number(response.headers()['x-retry-after'] ?? response.headers()['retry-after'] ?? '10')
      expect(Number.isFinite(seconds) && seconds >= 0 && seconds <= 15, 'Auth retry window must fit the test timeout').toBeTruthy()
      await new Promise(resolve => setTimeout(resolve, Math.ceil(seconds * 1000) + 100))
    }
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
    await expect(page.getByText('Total Contacts', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Create your first invoice', exact: true })).toBeVisible()
    // Re-enter through the consumer's entry point after authenticating. This also
    // exercises gateways that redirect login to a separate origin.
    await page.goto(entryURL)
    await expect(page).toHaveURL(entryURL)
    await expect(page.getByText('Total Contacts', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Create your first invoice', exact: true })).toBeVisible()
  })

  test('authenticated dashboard survives a reload', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
    await expect(page.getByText('Total Contacts', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Create your first invoice', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
    await expect(page.getByText('Total Contacts', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Create your first invoice', exact: true })).toBeVisible()
  })

  test('creates a contact through the UI and persists it', async ({ page, entryURL }) => {
    const name = `Browser customer ${Date.now()}`
    await page.goto(new URL('/contacts/new', entryURL).href)
    await page.getByLabel('Name *', { exact: true }).fill(name)
    await page.getByLabel('Email', { exact: true }).fill('customer@example.invalid')
    await page.getByRole('button', { name: 'Create Contact', exact: true }).click()
    await expect(page).toHaveURL(new URL('/contacts', entryURL).href)
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible()
    await page.goto(entryURL)
    await expect(page.getByText('Client on file', { exact: true })).toBeVisible()
  })

  test('creates a draft invoice with a calculated total and persists it', async ({ page, entryURL }) => {
    const input = draft(Date.now())
    await createContact(page, entryURL, input.customer)
    const created = await createDraftInvoice(page, entryURL, input)
    // 3 x 150.00 + 1 x 49.50 = 499.50; 10% tax = 49.95; total 549.45.
    expect(created.subtotal).toBe(49950)
    expect(created.total).toBe(54945)
    const expected = { ...input, ...created }
    await expectInvoiceDetail(page, expected)
    await expect(page.getByText(input.notes, { exact: true })).toBeVisible()
    await expect(page.getByText('Due Date:', { exact: true }).locator('xpath=..')).toContainText(created.due.detailText)

    await page.reload()
    await expectInvoiceDetail(page, expected)
    await expect(page.getByText(input.notes, { exact: true })).toBeVisible()
    await expect(page.getByText('Due Date:', { exact: true }).locator('xpath=..')).toContainText(created.due.detailText)

    await page.goto(new URL('/invoices', entryURL).href)
    // The list names a draft by its customer: it has no number to find it by.
    const row = page.getByRole('row').filter({ hasText: input.customer })
    await expect(row).toContainText(input.customer)
    await expect(row).toContainText(usd(created.total))
    await expect(row).toContainText('Draft')
    await page.goto(entryURL)
    await expect(page.getByText('Total Contacts', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Create your first invoice', exact: true })).toHaveCount(0)
  })

  test('edits a draft invoice and persists the recalculated total', async ({ page, entryURL }) => {
    const input = draft(Date.now())
    await createContact(page, entryURL, input.customer)
    await createDraftInvoice(page, entryURL, input)

    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByText('Edit Invoice', { exact: true })).toBeVisible()
    const first = lineRow(page, 0)
    await expect(first.getByPlaceholder('Description', { exact: true })).toHaveValue(input.lines[0].description)
    await first.getByRole('spinbutton').nth(0).fill('4')
    // 4 x 150.00 + 1 x 49.50 = 649.50; 10% tax = 64.95; total 714.45.
    const edited = { subtotal: 64950, tax: 6495, total: 71445 }
    await expectSummary(page, edited)
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click()

    const lines = [{ ...input.lines[0], quantity: 4 }, input.lines[1]]
    const expected = { ...input, ...edited, lines }
    await expectInvoiceDetail(page, expected)
    await page.reload()
    await expectInvoiceDetail(page, expected)
  })

  test('downloads a draft invoice PDF', async ({ page, entryURL }) => {
    const input = draft(Date.now())
    await createContact(page, entryURL, input.customer)
    await createDraftInvoice(page, entryURL, input)

    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'PDF', exact: true }).click()
    const file = await download
    // A draft has no number to name the file after.
    expect(file.suggestedFilename()).toBe('draft.pdf')
    const bytes = await readFile(await file.path())
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(bytes.byteLength).toBeGreaterThan(1000)
    expect(bytes.subarray(-1024).toString('latin1')).toContain('%%EOF')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
}
