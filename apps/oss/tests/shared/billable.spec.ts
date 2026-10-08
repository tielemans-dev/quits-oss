import { expect, test } from '@playwright/test'
import { prisma } from '../../src/lib/db'
import { bootstrapQuitsRuntime } from '../../src/lib/runtime/bootstrap'
import { resolveUserActor } from '../../src/domain/user-actor'
import { executeCommand, type CommandOutcome } from '../../src/domain/execute'
import { createAgreementDraft } from '../../src/domain/commands/agreements'
import { createInvoiceFromDeliverables } from '../../src/domain/commands/invoices-from-deliverables'
import { releaseDeliverableReservation } from '../../src/domain/commands/billing-allocation'
import { resetDatabase, seedCompletedSetup, loginAsAdmin } from '../e2e/support'

function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe('completed')
  if (outcome.status !== 'completed') throw new Error('Fixture command failed')
  return outcome.result
}

test.beforeEach(async ({ baseURL }) => {
  const database = new URL(process.env.DATABASE_URL!)
  if (baseURL !== 'http://127.0.0.1:4310' || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e') {
    throw new Error('Billable scenarios require the shared disposable environment')
  }
  await resetDatabase()
})

async function seedReservedWork() {
  bootstrapQuitsRuntime({})
  const setup = await seedCompletedSetup()
  const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: setup.adminUserId, userName: 'E2E Admin' })
  if (!actor) throw new Error('Missing fixture membership')
  const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: 'Billable customer', email: 'customer@example.invalid' } })
  const agreement = completed(await executeCommand(createAgreementDraft, {
    contactId: contact.id, title: 'Billable browser agreement', validUntil: '2099-01-01', taxRate: '0',
    deliverables: [{ title: 'Reviewed work', description: 'Service work', quantity: '1', unitPrice: '100' }],
  }, { actor }))
  // Synthetic starting state. Allocation, release, issuance, credit and rebill use real commands.
  await prisma.agreement.update({ where: { id: agreement.id }, data: { status: 'accepted' } })
  const deliverableId = agreement.deliverables[0]!.id
  await prisma.deliverable.update({ where: { id: deliverableId }, data: { status: 'accepted' } })
  const reserve = async () => completed(await executeCommand(createInvoiceFromDeliverables, { agreementId: agreement.id, deliverableIds: [deliverableId] }, { actor })).saleInvoiceId!
  const first = await reserve()
  return { actor, agreementId: agreement.id, deliverableId, first, reserve }
}

test('billable release opens the authorized draft and refuses a stale holder before refreshing to the new draft', async ({ page }, testInfo) => {
  const ctx = await seedReservedWork()
  await loginAsAdmin(page)
  await page.goto(`/agreements/${ctx.agreementId}`)
  const work = page.getByRole('group', { name: 'Reviewed work', exact: true })
  const link = work.getByRole('link', { name: 'Draft', exact: true })
  await expect(link).toHaveAttribute('href', `/invoices/${ctx.first}`)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/invoices/${ctx.first}$`))
  await expect(page.getByRole('row').filter({ hasText: 'Service work' })).toBeVisible()
  await page.goto(`/agreements/${ctx.agreementId}`)
  await work.getByRole('button', { name: 'Release from draft', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Remove Reviewed work from the draft Draft?')
  const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: ctx.first } })
  completed(await executeCommand(releaseDeliverableReservation, {
    agreementId: ctx.agreementId, deliverableId: ctx.deliverableId,
    expectedAllocation: { invoiceId: ctx.first, invoiceItemId: item.id, generation: 0 },
  }, { actor: ctx.actor }))
  const second = await ctx.reserve()
  const before = await prisma.invoice.findUniqueOrThrow({ where: { id: second }, include: { items: true } })
  await dialog.getByRole('button', { name: 'Release from draft', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('reservation changed after review')
  expect(await prisma.invoice.findUniqueOrThrow({ where: { id: second }, include: { items: true } })).toEqual(before)
  await page.screenshot({ path: testInfo.outputPath('stale-reservation-refused.png'), fullPage: true })
  await page.reload()
  await expect(work.getByRole('link', { name: 'Draft', exact: true })).toHaveAttribute('href', `/invoices/${second}`)
  await work.getByRole('button', { name: 'Release from draft', exact: true }).click()
  await dialog.getByRole('button', { name: 'Release from draft', exact: true }).click()
  await expect(work.locator('[data-allocation-state]')).toHaveAttribute('data-allocation-state', 'unbilled')
  expect((await prisma.deliverable.findUniqueOrThrow({ where: { id: ctx.deliverableId } })).billingStatus).toBe('unbilled')
  expect(await prisma.invoiceItem.count({ where: { invoiceId: second } })).toBe(0)
})

test('billable rebill confirmation requires a reason and refreshes credited work to unbilled with its history', async ({ page }, testInfo) => {
  const ctx = await seedReservedWork()
  await loginAsAdmin(page)
  await page.goto(`/invoices/${ctx.first}`)
  await page.getByRole('button', { name: 'Send without email', exact: true }).click()
  await page.getByRole('button', { name: 'Continue without email', exact: true }).click()
  await page.getByRole('button', { name: 'Create credit note', exact: true }).click()
  const creditDialog = page.getByRole('dialog')
  await creditDialog.getByLabel('Reason', { exact: true }).fill('Full correction for redelivery')
  await creditDialog.getByRole('button', { name: 'Issue credit note', exact: true }).click()
  await expect(page).toHaveURL(/\/credit-notes\/[^/]+$/)
  const before = await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.first }, include: { items: true } })
  await page.goto(`/agreements/${ctx.agreementId}`)
  const work = page.getByRole('group', { name: 'Reviewed work', exact: true })
  await expect(work.locator('[data-allocation-state]')).toHaveAttribute('data-allocation-state', 'credited')
  await work.getByRole('button', { name: 'Allow billing again', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  const confirm = dialog.getByRole('button', { name: 'Allow billing again', exact: true })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox').fill('Customer approved redelivery')
  await confirm.click()
  await expect(work.locator('[data-allocation-state]')).toHaveAttribute('data-allocation-state', 'unbilled')
  await expect(work).toContainText('Customer approved redelivery')
  expect(await prisma.deliverableRebill.count({ where: { deliverableId: ctx.deliverableId } })).toBe(1)
  expect(await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.first }, include: { items: true } })).toEqual(before)
  await page.screenshot({ path: testInfo.outputPath('rebill-recorded.png'), fullPage: true })
  await page.reload()
  await expect(work).toContainText('Customer approved redelivery')
})
