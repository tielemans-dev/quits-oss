import { test, expect } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { randomUUID } from "node:crypto"
import { executeCommand } from "../../src/domain/execute"
import { changeReceipt, previewReceiptChange, recordReceipt } from "../../src/domain/commands/settlements"
import { ensureTestMembership } from "../../src/test-utils/membership"
import { resolveUserActor } from "../../src/domain/user-actor"
import { resetDatabase, seedCompletedSetup, loginAsAdmin, waitForClientReady } from "./support"

test.beforeEach(async () => { await resetDatabase() })
test("previews a fee-funded receipt across invoices, then reverses and refunds with evidence", async ({ page }) => {
  const { organizationId } = await seedCompletedSetup()
  const contact = await prisma.contact.create({ data: { organizationId, name: "Settlement customer", email: "settlement@example.test" } })
  const invoices: Array<{ id: string }> = []
  for (const [index, total] of [1000, 500].entries()) invoices.push(await prisma.invoice.create({ data: {
    organizationId, contactId: contact.id, number: `INV-SETTLE-${index + 1}`, status: "sent", currency: "DKK", dueDate: new Date("2099-01-01"), subtotalNet: total / 1.25, totalTax: total / 5, totalGross: total,
    items: { create: [{ description: "Work", quantity: 1, unitPriceNet: total / 1.25, unitPriceGross: total, lineNet: total / 1.25, lineTax: total / 5, lineGross: total, taxRate: 25 }] },
  } }))
  await loginAsAdmin(page)
  await page.goto(`/invoices/${invoices[0].id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Record receipt", exact: true }).click()
  let dialog = page.getByRole("dialog")
  await dialog.getByLabel("Reference", { exact: true }).fill("BANK-SETTLE-1")
  await dialog.getByLabel("Net receipt", { exact: true }).fill("1485")
  await dialog.getByLabel("Processor fee", { exact: true }).fill("15")
  await dialog.getByLabel("Reason", { exact: true }).nth(0).fill("Bank statement")
  await dialog.getByLabel("Evidence link", { exact: true }).nth(0).fill("https://evidence.example.test/bank/1")
  await dialog.getByLabel("Reason", { exact: true }).nth(1).fill("Processor statement fee")
  await dialog.getByLabel("Evidence link", { exact: true }).nth(1).fill("https://evidence.example.test/fee/1")
  await dialog.getByRole("button", { name: "Preview balances" }).click()
  await expect(dialog.getByRole("status")).toContainText("Gross 1500.00")
  await expect(dialog.getByRole("status")).toContainText("Net 1485")
  expect(await prisma.settlementReceipt.count({ where: { organizationId } })).toBe(0)
  await dialog.getByRole("button", { name: "Confirm classification" }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole("button", { name: "Allocate receipt", exact: true }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByLabel("Amount (DKK)", { exact: true }).nth(0).fill("1000")
  await dialog.getByLabel("Amount (DKK)", { exact: true }).nth(1).fill("500")
  await dialog.getByLabel("Reason", { exact: true }).fill("Customer remittance")
  await dialog.getByLabel("Evidence link", { exact: true }).fill("https://evidence.example.test/remittance/1")
  await dialog.getByRole("button", { name: "Preview balances" }).click()
  await expect(dialog.getByRole("status")).toContainText("balance 1000.00 becomes 0.00 DKK")
  await expect(dialog.getByRole("status")).toContainText("balance 500.00 becomes 0.00 DKK")
  expect(await prisma.payment.count({ where: { organizationId } })).toBe(0)
  await page.screenshot({ path: process.env.QUITS_MONEY_SCREENSHOTS ? `${process.env.QUITS_MONEY_SCREENSHOTS}/split-allocation-preview.png` : test.info().outputPath("split-allocation-preview.png"), fullPage: true })
  await dialog.getByRole("button", { name: "Confirm classification" }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoices[0].id } })).paymentStatus).toBe("paid")
  await page.getByRole("button", { name: "Refund or reverse", exact: true }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByRole("combobox", { name: "Refund or reverse", exact: true }).selectOption("reverse_allocation")
  const payment = await prisma.payment.findFirstOrThrow({ where: { invoiceId: invoices[0].id } })
  await dialog.getByRole("combobox", { name: "Allocation or refund", exact: true }).selectOption(payment.id)
  await dialog.getByLabel("Reason", { exact: true }).fill("Cancelled supply")
  await dialog.getByLabel("Evidence link", { exact: true }).fill("https://evidence.example.test/cancellation/1")
  await dialog.getByRole("button", { name: "Preview balances" }).click()
  await expect(dialog.getByRole("status")).toContainText("balance 0.00 becomes 1000.00 DKK")
  await dialog.getByRole("button", { name: "Confirm classification" }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole("button", { name: "Refund or reverse", exact: true }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByLabel("Amount (DKK)", { exact: true }).fill("1000")
  await dialog.getByLabel("Reason", { exact: true }).fill("Bank refund sent")
  await dialog.getByLabel("Evidence link", { exact: true }).fill("https://evidence.example.test/refund/1")
  await dialog.getByRole("button", { name: "Preview balances" }).click()
  await expect(dialog.getByRole("status")).toContainText("balance 1000.00 becomes 0.00 DKK")
  await dialog.getByRole("button", { name: "Confirm classification" }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => prisma.settlementRefund.count({ where: { receipt: { organizationId } } })).toBe(1)
  const event = await prisma.domainEvent.findFirstOrThrow({ where: { organizationId, type: "settlement.changed" }, orderBy: { sequence: "desc" } })
  expect(event).toMatchObject({ actorKind: "user", payload: { action: "refund", reason: "Bank refund sent", evidence: "https://evidence.example.test/refund/1" } })
})


test("shows the classification being replaced and refuses a stale review", async ({ page }) => {
  const { organizationId } = await seedCompletedSetup()
  const otherUserId = randomUUID()
  await ensureTestMembership(organizationId, otherUserId, "admin")
  const resolvedActor = await resolveUserActor({ organizationId, userId: otherUserId })
  if (!resolvedActor) throw new Error("Second person was not created")
  const otherActor = resolvedActor
  const contact = await prisma.contact.create({ data: { organizationId, name: "Credit customer" } })
  const invoice = await prisma.invoice.create({ data: {
    organizationId, contactId: contact.id, number: "INV-CREDIT-1", status: "sent", currency: "DKK",
    dueDate: new Date("2099-01-01"), subtotalNet: 800, totalTax: 200, totalGross: 1000,
    items: { create: [{ description: "Work", quantity: 1, unitPriceNet: 800, unitPriceGross: 1000, lineNet: 800, lineTax: 200, lineGross: 1000, taxRate: 25 }] },
  } })
  const recorded = await executeCommand(recordReceipt, {
    requestId: randomUUID(), contactId: contact.id, currency: "DKK", netAmount: "100", feeAmount: "0",
    method: "bank_transfer", paidAt: "2026-01-15", reference: "BANK-CREDIT-1",
    reason: "Bank statement", evidence: "https://evidence.example.test/bank/credit",
  }, { actor: otherActor })
  if (recorded.status !== "completed") throw new Error(JSON.stringify(recorded))
  const receiptId = recorded.result.receiptId
  async function classify(reason: string, evidence: string) {
    const input = { requestId: randomUUID(), action: "customer_credit" as const, receiptId, reason, evidence }
    const preview = await prisma.$transaction(db => previewReceiptChange(db, organizationId, input))
    expect((await executeCommand(changeReceipt, { ...input, previewToken: preview.previewToken }, { actor: otherActor })).status).toBe("completed")
  }
  await classify("Retain for order B", "https://evidence.example.test/order-B")
  await loginAsAdmin(page)
  await page.goto(`/invoices/${invoice.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Refund or reverse", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("combobox", { name: "Refund or reverse", exact: true }).selectOption("customer_credit")
  await dialog.getByLabel("Reason", { exact: true }).fill("Retain for order A")
  await dialog.getByLabel("Evidence link", { exact: true }).fill("https://evidence.example.test/order-A")
  await dialog.getByRole("button", { name: "Preview balances" }).click()
  await expect(dialog.getByRole("status")).toContainText("Retain for order B")
  await expect(dialog.getByRole("status")).toContainText("Retain for order A")
  await expect(dialog.getByRole("status").getByRole("link", { name: "https://evidence.example.test/order-B", exact: true })).toHaveAttribute("href", "https://evidence.example.test/order-B")
  await classify("Retain for order C", "https://evidence.example.test/order-C")
  await dialog.getByRole("button", { name: "Confirm classification" }).click()
  await expect(dialog.getByRole("alert")).toContainText("Balances or classification changed")
  await expect(dialog.getByRole("button", { name: "Preview balances" })).toBeVisible()
  expect((await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: receiptId } })).creditReason).toBe("Retain for order C")
  expect(await prisma.domainEvent.count({ where: { organizationId, type: "settlement.changed" } })).toBe(2)
  await dialog.getByRole("button", { name: "Preview balances" }).click()
  await expect(dialog.getByRole("status")).toContainText("Retain for order C")
  await expect(dialog.getByRole("status")).toContainText("Retain for order A")
  await page.screenshot({ path: process.env.QUITS_MONEY_SCREENSHOTS ? `${process.env.QUITS_MONEY_SCREENSHOTS}/classification-replacement-preview.png` : test.info().outputPath("classification-replacement-preview.png"), fullPage: true })
  await dialog.getByRole("button", { name: "Confirm classification" }).click()
  await expect(dialog).toHaveCount(0)
  expect((await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: receiptId } })).creditReason).toBe("Retain for order A")
  expect(await prisma.domainEvent.count({ where: { organizationId, type: "settlement.changed" } })).toBe(3)
})
