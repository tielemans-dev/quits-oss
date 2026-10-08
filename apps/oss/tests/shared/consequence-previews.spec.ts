import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { buildOfferSnapshot, hashOfferSnapshot } from "../../src/domain/agreements/snapshot"
import { mintAgreementLink } from "../../src/lib/agreements/tokens"
import { resetDatabase, seedCompletedSetup, waitForClientReady } from "../e2e/support"

test("public acceptance preview identifies consequences, redacts private records, and supports keyboard review", async ({ page }) => {
  const database = new URL(process.env.DATABASE_URL!)
  if (database.hostname !== "127.0.0.1" || database.pathname !== "/quits_e2e") throw new Error("Requires the shared disposable browser database")
  await resetDatabase()
  const setup = await seedCompletedSetup()
  await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { companyEmail: "seller@example.test" } })
  const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Customer A", email: "customer-a@example.test" } })
  await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "PRIVATE-OTHER-CUSTOMER", email: "private-other@example.test" } })
  const agreement = await prisma.agreement.create({ data: {
    organizationId: setup.organizationId, contactId: contact.id, number: "AGR-PREVIEW", status: "sent", title: "Service agreement", offerFormatVersion: 2, taxRateInput: "0", calculationVersion: "v2",
    termsMarkdown: "Public service terms", notes: "PRIVATE-AGREEMENT-NOTE", acceptanceEvidenceNote: "PRIVATE-EVIDENCE", acceptanceIp: "PRIVATE-IP",
    validUntil: new Date("2099-01-01"), expiresAt: new Date("2099-01-02"), issueDate: new Date(), offerRevision: 1,
    issuedToEmail: contact.email, issuedVia: "manual", subtotalNet: 100, totalGross: 100,
    sellerSnapshot: { companyName: "Seller", companyEmail: "seller@example.test" }, buyerSnapshot: { name: contact.name, email: contact.email },
    deliverables: { create: [{ title: "Service", description: "Public service", taxRate: 0, vatTreatment: "out_of_scope", vatRateInput: "0", quantity: 1, unitPriceNet: 100, unitPriceGross: 100, lineNet: 100, lineGross: 100, sortOrder: 0 },
      { title: "Payment schedule", description: "Schedule", taxRate: 0, vatTreatment: "out_of_scope", vatRateInput: "0", quantity: 1, unitPriceNet: 50, unitPriceGross: 50, lineNet: 50, lineGross: 50, sortOrder: 1, isDeposit: true }] },
  }, include: { deliverables: true } })
  const snapshot = buildOfferSnapshot(agreement)
  await prisma.agreement.update({ where: { id: agreement.id }, data: { offerSnapshot: snapshot, offerSnapshotHash: hashOfferSnapshot(snapshot) } })
  const url = mintAgreementLink(agreement, "decide", new Date()).url
  const response = await page.goto(url)
  await waitForClientReady(page)
  await expect(page.getByRole("heading", { name: "Before you accept" })).toBeVisible()
  const preview = page.getByRole("region", { name: "Before you accept" })
  await expect(preview).toContainText("offer revision 1")
  await expect(preview).toContainText("seller@example.test")
  await expect(preview).toContainText("customer-a@example.test")
  await expect(preview).toContainText("creates no invoice drafts")
  await expect(preview).toContainText("Prepayment drafts cannot be issued yet")
  await expect(preview).toContainText("does not charge your card or collect money")
  const source = await response!.text()
  for (const value of ["PRIVATE-AGREEMENT-NOTE", "PRIVATE-EVIDENCE", "PRIVATE-IP", "PRIVATE-OTHER-CUSTOMER", "private-other@example.test"]) {
    expect(source).not.toContain(value)
    await expect(page.locator("body")).not.toContainText(value)
  }
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Download PDF" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByLabel("Your full name")).toBeFocused()
  await page.keyboard.type("Customer A")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("checkbox")).toBeFocused()
  await page.keyboard.press("Space")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Accept agreement", exact: true })).toBeFocused()
  expect(await prisma.payment.count({ where: { organizationId: setup.organizationId } })).toBe(0)
  expect(await prisma.invoice.count({ where: { organizationId: setup.organizationId } })).toBe(0)
  expect(await prisma.job.count({ where: { organizationId: setup.organizationId } })).toBe(0)
})
