import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { installHostedVatFixture } from "./hosted-vat-extension"
import { createAgreementDraft } from "../../src/domain/commands/agreements"
import { mintAgreementLink } from "../../src/lib/agreements/tokens"
import { captureHostedOnboarding, captureDocument, captureInvoiceEmail, captureOnboarding, capturePdf } from "./seller-vat-evidence"
import { buildCreditNoteEmailContent } from "../../src/lib/emails/credit-note-email"
import { issueDocument } from "../../src/application/issuance"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { createInvoiceDraft } from "../../src/domain/commands/invoices"
import { createQuoteDraft, sendQuote } from "../../src/domain/commands/quotes"
import { getPublicQuoteUrl } from "../../src/lib/quotes/public-url"
import { executeCommand } from "../../src/domain/execute"
import { resolveUserActor } from "../../src/domain/user-actor"
import { selfhostRuntimeServices } from "../../src/selfhost/runtime"
import { bootstrapQuitsRuntime } from "../../src/lib/runtime/bootstrap"
import { signInvoicePaymentToken } from "../../src/lib/payments/public"
import { translate } from "../../src/lib/i18n/translate"
import { isPublicDocumentPath } from "../../src/lib/theme"
import { danishLocale, loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

// MOCK: synthetic organizations and invoices only; the config refuses any other database.
async function capture(page: Page, surface: string, locale: string, savedChoice?: { organizationId: string; registered: boolean }) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.evaluate(() => localStorage.setItem("quits-theme", "system"))
    await page.reload()
    await waitForClientReady(page)
    // Recipient invoices, quotes and agreements stay light under either browser preference.
    const publicDocument = isPublicDocumentPath(new URL(page.url()).pathname)
    const expectedDark = !publicDocument && colorScheme === "dark"
    await expect(page.locator("html")).toHaveClass(expectedDark ? /\bdark\b/ : /^(?!.*\bdark\b)/)
    await expect(page.locator("html[data-document]")).toHaveCount(publicDocument ? 1 : 0)
    for (const [device, width] of [["desktop", 1440], ["mobile390", 390]] as const) {
      await page.setViewportSize({ width, height: 1100 })
      if (savedChoice) {
        await expect(page.getByRole("radio", { name: translate("vatStatus.yes", locale), exact: true })).toBeChecked({ checked: savedChoice.registered })
        await expect(page.getByRole("radio", { name: translate("vatStatus.no", locale), exact: true })).toBeChecked({ checked: !savedChoice.registered })
        await expect(page.locator("#taxRate")).toHaveValue(savedChoice.registered ? "25" : "0")
        const saved = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: savedChoice.organizationId } })
        expect(saved.momsRegistered).toBe(savedChoice.registered)
        expect(saved.taxRate?.toNumber()).toBe(savedChoice.registered ? 25 : 0)
        await writeFile(test.info().outputPath(`${surface}-${locale}-${colorScheme}-${device}-after.json`), JSON.stringify({
          sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          harnessRevision: process.env.EVIDENCE_SHA,
          ciRun: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
          ciAttempt: process.env.GITHUB_RUN_ATTEMPT,
          fixture: hosted ? "synthetic hosted contract, not released consumer acceptance" : "synthetic selfhost",
          revision: "after", locale, colorScheme, device, width, url: page.url(),
          savedMomsRegistered: saved.momsRegistered, savedTaxRate: saved.taxRate?.toNumber(),
          yesChecked: await page.getByRole("radio", { name: translate("vatStatus.yes", locale), exact: true }).isChecked(),
          noChecked: await page.getByRole("radio", { name: translate("vatStatus.no", locale), exact: true }).isChecked(),
          path: "UI choice, save, success toast, database persistence, reload, checked-state assertions, screenshot",
        }, null, 2))
      }
      await page.screenshot({ path: test.info().outputPath(`${surface}-${locale}-${colorScheme}-${device}-after.png`), fullPage: true })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }
}
const hosted = process.env.QUI62_HOSTED_FIXTURE === "true"
for (const locale of ["da-DK", "en-US"]) {
  test(`${hosted ? "hosted contract fixture" : "selfhost without hosted gate"} ${locale} issues without VAT`, async ({ page }) => {
    await resetDatabase()
    const setup = await seedCompletedSetup({ ...danishLocale, locale })
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
      companyName: "Synthetic Seller", companyAddress: "Testvej 1, 1000 København", taxRate: 25,
      paymentNote: translate("pdf.nonVatRegistered", locale),
      bankRegNumber: "0040", bankAccountNumber: "0440116243",
      ...(hosted ? { onboardingStatus: "complete", onboardingVersion: 2, onboardingCompletedAt: new Date(), onboardingInvoicingIdentity: "registered_business" } : {}),
    } })
    await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: "cvr", value: "12345674", countryCode: "DK" } })
    await loginAsAdmin(page)
    await page.goto("/settings/organization")
    await expect(page).toHaveURL(/\/settings$/)
    await waitForClientReady(page)
    for (const [countryCode, taxRegime] of [["US", "us_sales_tax"], ["DE", "eu_vat"], ["DK", "custom"]] as const) {
      await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { countryCode, taxRegime } })
      await page.reload()
      await waitForClientReady(page)
      await expect(page.getByRole("radio", { name: translate("vatStatus.no", locale), exact: true })).toHaveCount(0)
      await expect(page.getByText(translate("vatStatus.noHint", locale), { exact: true })).toHaveCount(0)
    }
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { countryCode: "DK", taxRegime: "eu_vat" } })
    await page.reload()
    await waitForClientReady(page)
    const yes = page.getByRole("radio", { name: translate("vatStatus.yes", locale), exact: true })
    const no = page.getByRole("radio", { name: translate("vatStatus.no", locale), exact: true })
    if (hosted) {
      await expect(yes).not.toBeChecked()
      await expect(no).not.toBeChecked()
    }
    await capture(page, "settings-unset", locale)
    await no.focus()
    await page.keyboard.press("Space")
    await expect(no).toBeChecked()
    await page.getByRole("button", { name: translate("settings.action.save", locale), exact: true }).click()
    await expect(page.getByText(translate("settings.success.saved", locale), { exact: true })).toBeVisible()
    await expect(page.locator("#taxRate")).toHaveValue("0")
    await page.reload()
    await waitForClientReady(page)
    await expect(yes).not.toBeChecked()
    await expect(no).toBeChecked()
    if (!hosted) {
      await expect(page.getByRole("button", { name: translate("vatStatus.withdraw", locale), exact: true })).toHaveCount(0)
    }
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: setup.organizationId } })).momsRegistered).toBe(false)
    await capture(page, "settings", locale)
    const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId, role: "admin" } })
    const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId })
    if (!actor) throw new Error("Synthetic admin is missing")
    if (hosted) installHostedVatFixture()
    else bootstrapQuitsRuntime({ services: selfhostRuntimeServices() })
    const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Synthetic Buyer", email: "buyer@example.test", address: "Testvej 2", city: "København", zip: "1000", country: "DK" } })
    // MOCK: VAT classification rates are fractions; the document taxRate is a percentage.
    const contradictory = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2026-11-09", taxRate: 25,
      items: [{ description: "Synthetic existing VAT draft", quantity: 1, unitPrice: 100, vat: { treatment: "standard", rate: "0.25" } }] }, { actor })
    if (contradictory.status !== "completed") throw new Error(JSON.stringify(contradictory))
    await page.goto(`/invoices/${contradictory.result.id}`)
    await waitForClientReady(page)
    await expect(page.getByText("25 % moms", { exact: true })).toBeVisible()
    await expect(page.getByText(translate("line.noVat", locale), { exact: true })).toHaveCount(0)
    await capture(page, "invoice-existing-vat-draft", locale)
    const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id, notes: translate("pdf.nonVatRegistered", locale), dueDate: "2026-11-09", supplyDate: "2026-10-11", taxRate: 0,
      items: [{ description: "Synthetic consulting", quantity: 2, unitPrice: 500, vat: { treatment: "unclassified_zero", rate: "0" } }] }, { actor })
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    await page.goto(`/invoices/${draft.result.id}`)
    await waitForClientReady(page)
    await expect(page.getByText(translate("line.noVat", locale), { exact: true })).toBeVisible()
    await page.getByRole("button", { name: translate("invoices.detail.email.degraded.trigger", locale), exact: true }).click()
    await page.getByRole("button", { name: translate("invoices.detail.email.degraded.confirm", locale), exact: true }).click()
    await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })).status).toBe("sent")
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toHaveCount(1)
    await capture(page, "invoice", locale)
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })
    const token = signInvoicePaymentToken({ invoiceId: row.id, keyVersion: row.publicPaymentKeyVersion, scope: "invoice_payment" }, "qui62-browser-payment-test-secret")
    await page.goto(`/pay/${encodeURIComponent(token)}`)
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toBeVisible()
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toHaveCount(1)
    await capture(page, "pay", locale)
    await captureInvoiceEmail(page, row.id, setup.organizationId, locale, `http://127.0.0.1:3040/pay/${encodeURIComponent(token)}`)
    await capturePdf(page, "invoice", row.id, locale)
    const quoteDraft = await executeCommand(createQuoteDraft, { contactId: contact.id, expiryDate: "2099-12-01", taxRate: 0,
      items: [{ description: "Synthetic consulting", quantity: 2, unitPrice: 500, vat: { treatment: "unclassified_zero", rate: "0" } }],
    }, { actor })
    if (quoteDraft.status !== "completed") throw new Error(JSON.stringify(quoteDraft))
    const quoteSent = await executeCommand(sendQuote, { id: quoteDraft.result.id, allowSendWithoutEmail: true }, { actor })
    if (quoteSent.status !== "completed") throw new Error(JSON.stringify(quoteSent))
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteDraft.result.id } })
    const quoteUrl = getPublicQuoteUrl(quote)
    if (!quoteUrl) throw new Error("Issued synthetic quote has no public URL")
    await page.goto(quoteUrl)
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toHaveCount(1)
    await expect(page.getByText(translate("line.noVat", locale), { exact: true })).toBeVisible()
    await capture(page, "quote-public", locale)
    const agreementDraft = await executeCommand(createAgreementDraft, { contactId: contact.id, title: "Synthetic non-VAT agreement", validUntil: "2099-12-01", taxRate: 0,
      deliverables: [{ title: "Synthetic service", description: "Service", quantity: 1, unitPrice: 100, vat: { treatment: "unclassified_zero", rate: "0" } }],
    }, { actor })
    if (agreementDraft.status !== "completed") throw new Error(JSON.stringify(agreementDraft))
    const agreementIssue = await issueDocument({ kind: "agreement", actor, commandInput: { id: agreementDraft.result.id }, options: { method: "manual" } })
    if (agreementIssue.status !== "completed") throw new Error(JSON.stringify(agreementIssue))
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementDraft.result.id } })
    // Customer-facing agreement status stays frozen after the seller's current choice changes.
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { momsRegistered: true } })
    const agreementLink = mintAgreementLink(agreement, "decide", new Date())
    await page.goto(`/a/${encodeURIComponent(agreementLink.token)}`)
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toHaveCount(1)
    await expect(page.getByText(translate("line.noVat", locale), { exact: true })).toBeVisible()
    await capture(page, "agreement-public", locale)
    // Freeze the credit choice from the invoice, even after current settings change.
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { momsRegistered: true } })
    const outcome = await issueDocument({ kind: "creditNote", actor, commandInput: { invoiceId: row.id, mode: "full", reason: translate("pdf.nonVatRegistered", locale) } })
    if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
    const credit = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: row.id }, include: { items: true } })
    await page.goto(`/credit-notes/${credit.id}`)
    await waitForClientReady(page)
    await expect(page.getByText(translate("pdf.nonVatRegistered", locale), { exact: true })).toHaveCount(1)
    await capture(page, "credit-note", locale)
    await capturePdf(page, "creditNote", credit.id, locale)
    const creditEmail = buildCreditNoteEmailContent({ creditNote: { number: credit.number, issueDate: credit.issueDate,
      sellerSnapshot: credit.sellerSnapshot, reason: credit.reason, subtotal: credit.subtotalNet.toNumber(), taxAmount: credit.totalTax.toNumber(), total: credit.totalGross.toNumber(), currency: credit.currency,
      priceBasis: "net", items: credit.items.map(item => ({ description: item.description, quantity: item.quantity.toNumber(), unitPrice: item.unitPriceNet.toNumber(), total: item.lineNet.toNumber(), taxRate: item.taxRate.toNumber() })) },
      invoice: { number: row.number!, issueDate: row.issueDate }, org: { locale }, contactName: "Synthetic Buyer" }).html
    expect(creditEmail.split(translate("pdf.nonVatRegistered", locale))).toHaveLength(2)
    await captureDocument(page, "credit-note-email", locale, creditEmail)
    if (hosted) await captureHostedOnboarding(page, setup.organizationId, locale)
    else await captureOnboarding(page, setup.organizationId, locale)
  })
}

// Each registration choice starts at a real app control, persists, and reaches app issuance.
const choiceScenarios = [
  { source: "settings", locale: "da-DK" },
  { source: "settings", locale: "en-US" },
  { source: "onboarding", locale: "da-DK" },
] as const
for (const { source, locale } of choiceScenarios) {
  for (const registered of [true, false]) {
    test(`${hosted ? "hosted contract fixture" : "selfhost"} ${source} choice ${registered} in ${locale} reaches invoice sending`, async ({ page }) => {
      test.skip(source === "onboarding" && !hosted, "Self-host onboarding has no hosted company review")
      await resetDatabase()
      const setup = await seedCompletedSetup({ ...danishLocale, locale })
      await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
        companyName: "Synthetic Seller", companyAddress: "Testvej 1, 1000 København",
        momsRegistered: null, taxRate: 0, bankRegNumber: "0040", bankAccountNumber: "0440116243",
        ...(hosted ? { onboardingStatus: "complete", onboardingVersion: 2, onboardingCompletedAt: new Date(), onboardingInvoicingIdentity: "registered_business" } : {}),
      } })
      await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: "cvr", value: "24256790", countryCode: "DK", isPrimary: true } })
      await loginAsAdmin(page)
      let organizationId = setup.organizationId
      if (source === "onboarding") {
        organizationId = await captureHostedOnboarding(page, setup.organizationId, locale, registered)
      } else {
        await page.goto("/settings/organization")
        await expect(page).toHaveURL(/\/settings$/)
        await waitForClientReady(page)
        await page.getByRole("radio", { name: translate(registered ? "vatStatus.yes" : "vatStatus.no", locale), exact: true }).check()
        await page.getByRole("button", { name: translate("settings.action.save", locale), exact: true }).click()
        await expect(page.getByText(translate("settings.success.saved", locale), { exact: true })).toBeVisible()
        await expect(page.getByRole("radio", { name: translate("vatStatus.yes", locale), exact: true })).toBeChecked({ checked: registered })
        await expect(page.getByRole("radio", { name: translate("vatStatus.no", locale), exact: true })).toBeChecked({ checked: !registered })
      }
      const saved = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId } })
      expect(saved.momsRegistered).toBe(registered)
      expect(saved.taxRate?.toNumber()).toBe(registered ? 25 : 0)
      await page.goto("/settings")
      await page.reload()
      await waitForClientReady(page)
      await expect(page.getByRole("radio", { name: translate(registered ? "vatStatus.yes" : "vatStatus.no", locale), exact: true })).toBeChecked()
      await expect(page.getByRole("radio", { name: translate(registered ? "vatStatus.no" : "vatStatus.yes", locale), exact: true })).not.toBeChecked()
      await expect(page.locator("#taxRate")).toHaveValue(registered ? "25" : "0")
      if (source === "settings") await capture(page, `settings-saved-${registered}`, locale, { organizationId, registered })
      const member = await prisma.member.findFirstOrThrow({ where: { organizationId, role: { in: ["owner", "admin"] } } })
      const actor = await resolveUserActor({ organizationId, userId: member.userId })
      if (!actor) throw new Error("Synthetic admin is missing")
      if (hosted) installHostedVatFixture()
      else bootstrapQuitsRuntime({ services: selfhostRuntimeServices() })
      const contact = await prisma.contact.create({ data: { organizationId, name: "Synthetic Buyer", email: "buyer@example.test", address: "Testvej 2", city: "København", zip: "1000", country: "DK" } })
      const draft = await executeCommand(createInvoiceDraft, {
        contactId: contact.id, dueDate: "2026-11-09", supplyDate: "2026-10-11", taxRate: saved.taxRate!.toNumber(),
        items: [{ description: "Synthetic service", quantity: 1, unitPrice: 100, vat: registered ? { treatment: "standard", rate: "0.25" } : { treatment: "unclassified_zero", rate: "0" } }],
      }, { actor })
      if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
      await page.goto(`/invoices/${draft.result.id}`)
      await waitForClientReady(page)
      await page.getByRole("button", { name: translate("invoices.detail.email.degraded.trigger", locale), exact: true }).click()
      await page.getByRole("button", { name: translate("invoices.detail.email.degraded.confirm", locale), exact: true }).click()
      await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })).status).toBe("sent")
      const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })
      expect(issued.sellerSnapshot).toMatchObject({ momsRegistered: registered })
      expect(issued.totalTax.toNumber()).toBe(registered ? 25 : 0)
    })
  }
}

// Persist and issue through production commands, then capture the real recipient routes and exports.
// Mixed VAT is supported by selfhost. Hosted evidence asserts its policy refusal and captures
// ordinary domestic VAT instead; it must never present that PDF as hosted mixed-VAT evidence.
for (const locale of ["da-DK", "en-US"]) {
  for (const scenario of ["buyer-tax-id-mixed-vat-multipage", "empty-company"] as const) {
    const evidenceScenario = hosted && scenario === "buyer-tax-id-mixed-vat-multipage" ? "buyer-tax-id-standard-vat-multipage" : scenario
    test(`${hosted ? "hosted contract fixture" : "selfhost"} ${locale} legal evidence ${evidenceScenario}`, async ({ page }) => {
      await resetDatabase()
      const setup = await seedCompletedSetup({ ...danishLocale, locale })
      const mixed = scenario === "buyer-tax-id-mixed-vat-multipage"
      await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
        companyName: "Synthetic Seller", companyAddress: "Testvej 1, 1000 København",
        momsRegistered: mixed, taxRate: mixed ? 25 : 0, pricesIncludeTax: false,
        bankRegNumber: "0040", bankAccountNumber: "0440116243",
        ...(hosted ? { onboardingStatus: "complete", onboardingVersion: 2, onboardingCompletedAt: new Date(), onboardingInvoicingIdentity: "registered_business" } : {}),
      } })
      await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: "cvr", value: "12345674", countryCode: "DK" } })
      const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId,
        name: "Synthetic Buyer", company: null, email: "buyer@example.test", address: "Testvej 2", city: "København", zip: "1000", country: "DK",
        taxIds: { create: { scheme: "vat", value: "DK24256790", countryCode: "DK", isPrimary: true } },
      } })
      const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId, role: "admin" } })
      const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId })
      if (!actor) throw new Error("Synthetic admin is missing")
      if (hosted) installHostedVatFixture()
      else bootstrapQuitsRuntime({ services: selfhostRuntimeServices() })
      await loginAsAdmin(page)
      if (hosted) {
        // A database momsRegistered value is not operator confirmation. Use the real control
        // after the final seller identity has been persisted, as the existing functional cases do.
        await page.goto("/settings")
        await waitForClientReady(page)
        await page.getByRole("radio", { name: translate(mixed ? "vatStatus.yes" : "vatStatus.no", locale), exact: true }).check()
        await page.getByRole("button", { name: translate("settings.action.save", locale), exact: true }).click()
        await expect(page.getByText(translate("settings.success.saved", locale), { exact: true })).toBeVisible()
      }
      let items = Array.from({ length: mixed ? 60 : 1 }, (_, index) => ({
        description: `Synthetic service ${index + 1}`, quantity: 1, unitPrice: 100,
        vat: mixed ? index % 2 === 0 ? { treatment: "standard" as const, rate: "0.25" }
          : { treatment: "exempt" as const, reasonCode: "health" as const, rate: "0" }
          : { treatment: "unclassified_zero" as const, rate: "0" },
      }))
      // Synthetic classification evidence only, not proposed customer-facing legal wording.
      let vatEvidence = mixed ? { statementText: "Synthetic health exemption evidence" } : undefined
      if (hosted && mixed) {
        const unsupported = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2099-12-01",
          supplyDate: "2026-10-11", taxRate: 25, items, vatEvidence,
        }, { actor })
        if (unsupported.status !== "completed") throw new Error(JSON.stringify(unsupported))
        const refused = await issueDocument({ kind: "invoice", actor, commandInput: { id: unsupported.result.id, allowSendWithoutEmail: true } })
        expect(refused).toMatchObject({ status: "failed", error: { code: "invoice_issuance_policy", message: expect.stringContaining("Only ordinary domestic sales with 25% VAT are supported") } })
        if (refused.status !== "failed") throw new Error("Hosted mixed-VAT issuance must be refused")
        expect(refused.error.message).not.toContain("confirmation is missing")
        const unchanged = await prisma.invoice.findUniqueOrThrow({ where: { id: unsupported.result.id } })
        expect(unchanged.status).toBe("draft")
        expect(unchanged.number).toBeNull()
        expect(unchanged.artifactPdfRef).toBeNull()
        await writeFile(test.info().outputPath(`hosted-mixed-vat-coverage-gap-${locale}.txt`),
          "Hosted policy rejects mixed VAT. Mixed-VAT /pay, /q and stored multipage PDF evidence belongs to the selfhost lane. This hosted case captures a supported 60-line domestic 25% invoice and credit note, with buyer VAT ID and empty buyer company. No hosted mixed-VAT issuance or PDF is claimed.\n")
        items = items.map(item => ({ ...item, vat: { treatment: "standard" as const, rate: "0.25" } }))
        vatEvidence = undefined
      }
      const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2099-12-01",
        supplyDate: "2026-10-11", taxRate: mixed ? 25 : 0, items, vatEvidence,
      }, { actor })
      if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
      // invoice.send uses email semantics even when allowSendWithoutEmail permits degraded delivery.
      // Reservation and commit must hash the same method.
      const issued = await issueDocument({ kind: "invoice", actor, commandInput: { id: draft.result.id, allowSendWithoutEmail: true } })
      if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })
      expect(invoice.status).toBe("sent")
      expect(invoice.buyerSnapshot).toMatchObject({ company: null, taxIds: [{ scheme: "vat", value: "DK24256790", countryCode: "DK" }] })
      expect(invoice.sellerSnapshot).toMatchObject({ companyName: "Synthetic Seller", momsRegistered: mixed })
      expect(invoice.subtotalNet.toNumber()).toBe(mixed ? 6000 : 100)
      expect(invoice.totalTax.toNumber()).toBe(mixed ? (hosted ? 1500 : 750) : 0)
      expect(invoice.totalGross.toNumber()).toBe(mixed ? (hosted ? 7500 : 6750) : 100)
      const token = signInvoicePaymentToken({ invoiceId: invoice.id, keyVersion: invoice.publicPaymentKeyVersion, scope: "invoice_payment" }, "qui62-browser-payment-test-secret")
      await page.goto(`/pay/${encodeURIComponent(token)}`)
      await expect(page.getByText(/DK24256790/)).toBeVisible()
      await expect(page.getByText("Synthetic service 1", { exact: true })).toBeVisible()
      await capture(page, `pay-${evidenceScenario}`, locale)
      await capturePdf(page, "invoice", invoice.id, locale, { scenario: evidenceScenario, minPages: mixed ? 2 : 1,
        expectedText: ["DK24256790", "Synthetic Buyer", `Synthetic service ${mixed ? 60 : 1}`], invoiceFooter: true })
      const quoteDraft = await executeCommand(createQuoteDraft, { contactId: contact.id, expiryDate: "2099-12-01", taxRate: mixed ? 25 : 0, items, vatEvidence }, { actor })
      if (quoteDraft.status !== "completed") throw new Error(JSON.stringify(quoteDraft))
      const sent = await executeCommand(sendQuote, { id: quoteDraft.result.id, allowSendWithoutEmail: true }, { actor })
      if (sent.status !== "completed") throw new Error(JSON.stringify(sent))
      const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteDraft.result.id } })
      expect(quote.buyerSnapshot).toMatchObject({ company: null, taxIds: [{ scheme: "vat", value: "DK24256790", countryCode: "DK" }] })
      const url = getPublicQuoteUrl(quote)
      if (!url) throw new Error("Issued synthetic quote has no public URL")
      await page.goto(url)
      await expect(page.getByText(/DK24256790/)).toBeVisible()
      await expect(page.getByText(`Synthetic service ${mixed ? 60 : 1}`, { exact: true })).toBeVisible()
      await capture(page, `quote-public-${evidenceScenario}`, locale)
      const credit = await issueDocument({ kind: "creditNote", actor, commandInput: { invoiceId: invoice.id, mode: "full", reason: "Synthetic correction" } })
      if (credit.status !== "completed") throw new Error(JSON.stringify(credit))
      const creditNote = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: invoice.id } })
      expect(creditNote.buyerSnapshot).toMatchObject({ company: null, taxIds: [{ scheme: "vat", value: "DK24256790", countryCode: "DK" }] })
      expect(creditNote.totalTax.toNumber()).toBe(invoice.totalTax.toNumber())
      expect(creditNote.totalGross.toNumber()).toBe(invoice.totalGross.toNumber())
      await capturePdf(page, "creditNote", creditNote.id, locale, { scenario: evidenceScenario, minPages: mixed ? 2 : 1,
        expectedText: ["DK24256790", "Synthetic Buyer", `Synthetic service ${mixed ? 60 : 1}`] })
    })
  }
}
