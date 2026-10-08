import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test"
import { executeIssuanceCommand } from "../../src/application/issuance"
import { createAgreementDraft } from "../../src/domain/commands/agreements"
import { issueAgreement, recordAgreementAcceptance } from "../../src/domain/commands/agreement-lifecycle"
import { markDeliverableDelivered } from "../../src/domain/commands/deliverables"
import { executeCommand, type CommandOutcome } from "../../src/domain/execute"
import { resolveUserActor } from "../../src/domain/user-actor"
import { prisma } from "../../src/lib/db"
import { bootstrapQuitsRuntime } from "../../src/lib/runtime/bootstrap"
import { setRuntimeServices } from "../../src/lib/runtime/services"
import { adminCredentials, loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

/**
 * The client action page in a browser: the seller creates links with different roles, and the
 * recipients use them on a phone and with the keyboard. A fake mail provider receives the
 * verification codes.
 */
const browserErrors: Array<{ kind: "crash" | "pageerror" | "console"; path: string; message: string }> = []
function observePage(page: Page) {
  const record = (kind: (typeof browserErrors)[number]["kind"], message: string) => browserErrors.push({ kind, path: new URL(page.url()).pathname, message })
  page.on("crash", () => record("crash", "Page crashed"))
  page.on("pageerror", (error) => record("pageerror", error.message))
  page.on("console", (message) => { if (message.type() === "error") record("console", message.text()) })
}
async function screenshot(page: Page, name: string, info: TestInfo = test.info()) {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await info.attach(name, { path, contentType: "image/png" })
}

const mailbox = resolve(process.env.CLIENT_ACTIONS_MAILBOX ?? "test-results/client-actions-mail.jsonl")
function capturedMessages(): Array<{ to: string; subject: string; html: string }> {
  return readFileSync(mailbox, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

function completed<T>(outcome: CommandOutcome<T>): T {
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}

/** Documents are issued by this process, which has no filesystem store: synthetic adapters stand in. */
function useSyntheticArtifacts() {
  bootstrapQuitsRuntime({})
  const objects = new Map<string, Uint8Array>()
  setRuntimeServices({
    documentRenderer: { version: "synthetic-e2e-v1", async renderPdf(input) { return new TextEncoder().encode(JSON.stringify(input)) } },
    documentArtifactStore: {
      async put(bytes, meta) { const ref = `${meta.organizationId}/${meta.documentId}/${meta.hash}`; objects.set(ref, bytes); return ref },
      async get(ref) { return objects.get(ref) ?? null },
      async head() { return null },
      async delete(ref) { objects.delete(ref) },
    },
  })
}

async function seed() {
  useSyntheticArtifacts()
  const setup = await seedCompletedSetup()
  await prisma.orgSettings.update({
    where: { organizationId: setup.organizationId },
    data: { stripePublishableKey: "pk_test_123456789", stripeSecretKeyEnc: "sk_test_placeholder", stripeWebhookSecretEnc: "whsec_placeholder" },
  })
  const actor = (await resolveUserActor({ organizationId: setup.organizationId, userId: setup.adminUserId! }))!
  const contact = await prisma.contact.create({
    data: { organizationId: setup.organizationId, name: "Client Customer", email: "client@example.test" },
  })
  const invoice = await prisma.invoice.create({
    data: {
      organizationId: setup.organizationId, contactId: contact.id, number: "INV-CLIENT-0001", status: "sent", paymentStatus: "unpaid",
      issueDate: new Date("2026-03-09T00:00:00.000Z"), dueDate: new Date("2099-03-23T00:00:00.000Z"),
      publicPaymentIssuedAt: new Date("2026-03-09T00:00:00.000Z"), publicPaymentKeyVersion: 1,
      subtotalNet: "100.00", totalTax: "0.00", totalGross: "100.00", currency: "USD", countryCode: "US", locale: "en-US", timezone: "UTC",
      taxRegime: "us_sales_tax", pricesIncludeTax: false,
      sellerSnapshot: { companyName: "E2E Org", companyEmail: adminCredentials.email },
      buyerSnapshot: { name: contact.name, email: contact.email },
      items: { create: [{ description: "Implementation sprint", quantity: "1.00", unitPriceNet: "100.00", unitPriceGross: "100.00", lineNet: "100.00", lineTax: "0.00", lineGross: "100.00", taxRate: "0.00", taxCategory: "standard", sortOrder: 0 }] },
    },
  })
  const now = new Date()
  async function agreement(title: string, accepted: boolean) {
    const draft = completed(await executeCommand(createAgreementDraft, {
      title, contactId: contact.id, validUntil: "2099-01-01", billingTrigger: "on_delivery",
      deliverables: [{ title: `${title} work`, description: "Agreed work", quantity: "1", unitPrice: "100" }],
    }, { actor, now }))
    completed(await executeIssuanceCommand(issueAgreement, { id: draft.id, recipient: "client@example.test" }, { actor, now }))
    if (accepted) completed(await executeCommand(recordAgreementAcceptance, { id: draft.id, acceptedByName: "Client", evidenceNote: "Confirmed in writing" }, { actor, now }))
    return prisma.agreement.findUniqueOrThrow({ where: { id: draft.id }, include: { deliverables: true } })
  }
  const open = await agreement("Open offer", false)
  const signed = await agreement("Signed offer", true)
  const line = signed.deliverables[0]!
  completed(await executeCommand(markDeliverableDelivered, { agreementId: signed.id, id: line.id }, { actor, now }))
  writeFileSync(mailbox, "")
  return { setup, contact, invoice, open, signed, line }
}

/** Creates a link in the seller's UI from a role preset and returns its address. */
async function createLinkAsSeller(page: Page, contactId: string, preset: "Finance contact" | "Project approver") {
  await page.goto(`/contacts/${contactId}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Create client link", exact: true }).click()
  await page.getByRole("button", { name: preset, exact: true }).click()
  await page.getByRole("button", { name: "Create link", exact: true }).click()
  const created = page.getByTestId("created-client-link")
  await expect(created).toBeVisible()
  return created.getByRole("textbox").inputValue()
}

async function visitor(browser: Browser, width = 1280, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  observePage(page)
  return { context, page }
}

async function tabTo(page: Page, name: string, limit = 25) {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press("Tab")
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      return element ? `${element.getAttribute("aria-label") ?? ""}|${element.textContent ?? ""}` : ""
    })
    if (focused.includes(name)) return
  }
  throw new Error(`Could not reach "${name}" with the keyboard`)
}

test.beforeEach(async ({ page }) => {
  browserErrors.length = 0
  observePage(page)
  await resetDatabase()
})
test.afterEach(async () => {
  const info = test.info()
  if (browserErrors.length) {
    await info.attach("browser-runtime-diagnostics", {
      body: JSON.stringify(browserErrors, null, 2), contentType: "application/json",
    })
  }
  expect(browserErrors, "Browser runtime errors").toEqual([])
})

test("a finance contact sees and can pay only their invoice, on a phone and with the keyboard", async ({ page, browser }) => {
  const data = await seed()
  await loginAsAdmin(page)
  const url = await createLinkAsSeller(page, data.contact.id, "Finance contact")

  const { page: phone, context } = await visitor(browser, 390, 844)
  await phone.goto(url)
  await waitForClientReady(phone)
  await expect(phone.getByRole("heading", { level: 1 })).toHaveText("Your documents from E2E Org")
  await expect(phone.getByTestId("client-action-summary")).toHaveText("Waiting for you: 1")
  await expect(phone.getByRole("heading", { name: "Invoices" })).toBeVisible()
  await expect(phone.getByText("INV-CLIENT-0001")).toBeVisible()
  // The finance contact holds nothing about the agreements or the delivery.
  await expect(phone.getByRole("heading", { name: "Agreements" })).toHaveCount(0)
  await expect(phone.getByRole("heading", { name: "Deliveries to sign off" })).toHaveCount(0)
  await expect(phone.getByText("Open offer")).toHaveCount(0)
  await expect(phone.getByText("Verify your email address")).toHaveCount(0)
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  // Tap targets are comfortable and the pay action is full width on a phone.
  const pay = phone.getByRole("button", { name: /^Pay \$100\.00$/ })
  await expect(pay).toBeEnabled()
  expect((await pay.boundingBox())!.height).toBeGreaterThanOrEqual(36)
  expect((await pay.boundingBox())!.width).toBeGreaterThan(300)
  await screenshot(phone, "finance-mobile")

  // The whole task is reachable from the keyboard, and the detail opens and closes without a mouse.
  await tabTo(phone, "Pay $100.00")
  await tabTo(phone, "View invoice")
  await phone.keyboard.press("Enter")
  await expect(phone.getByText("Implementation sprint")).toBeVisible()
  await expect(phone).toHaveURL(/item=invoice(:|%3A)/)
  await tabTo(phone, "Back to your documents")
  await phone.keyboard.press("Enter")
  await expect(phone.getByRole("heading", { name: "Invoices" })).toBeVisible()
  // A record id swapped into the address, or another record kind, shows nothing extra.
  await phone.goto(`${url}?item=agreement:${data.open.id}`)
  await waitForClientReady(phone)
  await expect(phone.getByText("Open offer")).toHaveCount(0)
  await expect(phone.getByRole("heading", { name: "Invoices" })).toBeVisible()
  await context.close()

  // The seller's preview shows the same records with inert buttons.
  await page.goto(`/contacts/${data.contact.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Preview", exact: true }).click()
  const preview = page.getByTestId("client-link-preview")
  await expect(preview.getByText("INV-CLIENT-0001")).toBeVisible()
  await expect(preview.getByText("Preview. This is exactly what Client Customer sees.")).toBeVisible()
  await expect(preview.getByRole("button", { name: /^Pay \$100\.00$/ })).toBeDisabled()
  await expect(preview.getByText("Open offer")).toHaveCount(0)
  await screenshot(page, "seller-preview")
})

test("a project approver verifies their email, then signs off the delivery and accepts the agreement", async ({ page, browser }) => {
  const data = await seed()
  await loginAsAdmin(page)
  const url = await createLinkAsSeller(page, data.contact.id, "Project approver")

  const { page: approver, context } = await visitor(browser)
  await approver.goto(url)
  await waitForClientReady(approver)
  await expect(approver.getByTestId("client-action-summary")).toHaveText("Waiting for you: 2")
  await expect(approver.getByRole("heading", { name: "Agreements" })).toBeVisible()
  await expect(approver.getByRole("heading", { name: "Deliveries to sign off" })).toBeVisible()
  await expect(approver.getByRole("heading", { name: "Invoices" })).toHaveCount(0)
  await expect(approver.getByText("INV-CLIENT-0001")).toHaveCount(0)

  // Nothing can be decided before the recipient proves they hold the address.
  await expect(approver.getByRole("heading", { name: "Confirm it is you before approving" })).toBeVisible()
  await screenshot(approver, "approver-verification")
  await approver.getByRole("link", { name: "Review and sign off" }).click()
  await expect(approver.getByRole("button", { name: "Accept delivery" })).toHaveCount(0)
  await expect(approver.getByText("Verify your email address to decide.")).toBeVisible()
  await approver.getByRole("button", { name: "Email me a code" }).click()
  await expect(approver.getByText("A code was sent. It is valid for 10 minutes.")).toBeVisible()
  await expect.poll(() => capturedMessages().length).toBe(1)
  expect(capturedMessages()[0]).toMatchObject({ to: "client@example.test" })
  const code = capturedMessages()[0]!.html.match(/>(\d{6})</)![1]!
  const wrong = code === "000000" ? "111111" : "000000"
  await approver.getByLabel("Six-digit code").fill(wrong)
  await approver.getByRole("button", { name: "Verify" }).click()
  await expect(approver.getByText("That code is not right. Check it and try again.")).toBeVisible()
  await approver.getByLabel("Six-digit code").fill(code)
  await approver.getByRole("button", { name: "Verify" }).click()
  await expect(approver.getByRole("heading", { name: "Confirm it is you before approving" })).toHaveCount(0)

  // Sign off the delivery with the keyboard only.
  const confirm = approver.getByRole("checkbox", { name: "I have reviewed and accept this delivery." })
  await confirm.focus()
  await approver.keyboard.press("Space")
  await expect(confirm).toBeChecked()
  await tabTo(approver, "Accept delivery")
  await approver.keyboard.press("Enter")
  await expect(approver.getByText("Thank you. The delivery is signed off.")).toBeVisible()
  await expect.poll(async () => (await prisma.deliverable.findUniqueOrThrow({ where: { id: data.line.id } })).status).toBe("accepted")

  // Then accept the agreement waiting for a decision.
  await approver.getByRole("link", { name: "Back to your documents" }).click()
  await approver.getByRole("link", { name: "Review and decide" }).click()
  await approver.getByLabel("Your full name").fill("Alex Approver")
  await approver.getByRole("checkbox").check()
  await approver.getByRole("button", { name: "Accept agreement", exact: true }).click()
  await expect(approver.getByText("Thank you. The agreement is accepted.")).toBeVisible()
  expect(await prisma.agreement.findUniqueOrThrow({ where: { id: data.open.id } })).toMatchObject({ status: "accepted", acceptedByName: "Alex Approver" })
  await context.close()

  // A forwarded copy of the link opens the page but not the approvals: it has no verified session.
  const { page: forwarded, context: other } = await visitor(browser)
  await forwarded.goto(url)
  await waitForClientReady(forwarded)
  await expect(forwarded.getByRole("heading", { name: "Agreements" })).toBeVisible()
  await expect(forwarded.getByText("Signed offer work")).toBeVisible()
  await expect(forwarded.getByRole("heading", { name: "Confirm it is you before approving" })).toBeVisible()
  await other.close()
})

test("a revoked or expired link shows no records and says whom to ask", async ({ page, browser }) => {
  const data = await seed()
  await loginAsAdmin(page)
  const financeUrl = await createLinkAsSeller(page, data.contact.id, "Finance contact")
  const approverUrl = await createLinkAsSeller(page, data.contact.id, "Project approver")

  const { page: guest, context } = await visitor(browser)
  await guest.goto(financeUrl)
  await expect(guest.getByText("INV-CLIENT-0001")).toBeVisible()

  // The seller revokes the finance link; the very next load is refused.
  await page.goto(`/contacts/${data.contact.id}`)
  await waitForClientReady(page)
  page.once("dialog", (dialog) => void dialog.accept())
  await page.getByTestId("client-link-row").filter({ hasText: "Client Customer" }).filter({ hasText: "Invoice" }).getByRole("button", { name: "Revoke" }).click()
  await expect(page.getByText("Revoked").first()).toBeVisible()
  await guest.reload()
  await waitForClientReady(guest)
  await expect(guest.getByRole("heading", { name: "This link is no longer active" })).toBeVisible()
  await expect(guest.getByText("Ask E2E Org to send you a new link.")).toBeVisible()
  await expect(guest.getByText("INV-CLIENT-0001")).toHaveCount(0)
  expect((await guest.request.get(`${financeUrl.replace(/\/c\/([^?]+).*/, "/c/$1")}/download/invoice/${data.invoice.id}`)).status()).toBe(404)

  // The approver link expires on its own.
  await prisma.clientActionLink.updateMany({ where: { verification: "email_code" }, data: { expiresAt: new Date(Date.now() - 1000) } })
  await guest.goto(approverUrl)
  await waitForClientReady(guest)
  await expect(guest.getByRole("heading", { name: "This link has expired" })).toBeVisible()
  await screenshot(guest, "expired-link")
  await expect(guest.getByText("Signed offer")).toHaveCount(0)

  // A mistyped address is simply invalid.
  const stranger = await context.newPage()
  observePage(stranger)
  await stranger.goto(`${approverUrl.slice(0, -4)}abcd`)
  await waitForClientReady(stranger)
  await expect(stranger.getByRole("heading", { name: "This link is not valid" })).toBeVisible()
  await context.close()
})

test("an expired verification cookie restores the form and allows a new code without reload", async ({ page, browser }) => {
  const data = await seed()
  await loginAsAdmin(page)
  const url = await createLinkAsSeller(page, data.contact.id, "Project approver")
  const { page: approver, context } = await visitor(browser, 390, 844)
  await approver.goto(url)
  await waitForClientReady(approver)
  await approver.getByRole("link", { name: "Review and sign off" }).click()
  async function verifyEmail() {
    const previous = capturedMessages().length
    await approver.getByRole("button", { name: "Email me a code" }).click()
    await expect.poll(() => capturedMessages().length).toBe(previous + 1)
    const code = capturedMessages().at(-1)!.html.match(/>(\d{6})</)![1]!
    await approver.getByLabel("Six-digit code").fill(code)
    await approver.getByRole("button", { name: "Verify", exact: true }).click()
    await expect(approver.getByRole("heading", { name: "Confirm it is you before approving" })).toHaveCount(0)
  }
  await verifyEmail()
  const verificationCookies = (await context.cookies()).filter((cookie) => cookie.name.startsWith("qca_"))
  expect(verificationCookies).toHaveLength(1)
  const cookie = verificationCookies[0]!
  // The browser removes a cookie at expiry while the already-rendered page stays open. Expire the
  // actual httpOnly cookie rather than mocking the server response or advancing only browser time.
  await context.addCookies([{ ...cookie, expires: Math.floor(Date.now() / 1000) - 1 }])
  expect((await context.cookies()).some((value) => value.name === cookie.name)).toBe(false)
  await approver.getByRole("checkbox", { name: "I have reviewed and accept this delivery." }).check()
  await approver.getByRole("button", { name: "Accept delivery", exact: true }).click()
  await expect(approver.getByRole("alert")).toHaveText("Verify your email address first.")
  await expect(approver.getByRole("heading", { name: "Confirm it is you before approving" })).toBeVisible()
  await expect(approver.getByRole("button", { name: "Accept delivery", exact: true })).toHaveCount(0)
  expect(await prisma.deliverable.findUniqueOrThrow({ where: { id: data.line.id } })).toMatchObject({ status: "delivered", acceptedAt: null })
  await screenshot(approver, "verification-expired-recovery")
  await verifyEmail()
  await approver.getByRole("checkbox", { name: "I have reviewed and accept this delivery." }).check()
  await approver.getByRole("button", { name: "Accept delivery", exact: true }).click()
  await expect(approver.getByText("Thank you. The delivery is signed off.")).toBeVisible()
  expect(await prisma.deliverable.findUniqueOrThrow({ where: { id: data.line.id } })).toMatchObject({ status: "accepted", acceptedRevision: 1 })
  await context.close()
})

test("expired delivery review stays closed after reload and client-link renewal", async ({ page, browser }) => {
  const data = await seed()
  await prisma.deliverable.update({ where: { id: data.line.id }, data: { deliveredAt: new Date(Date.now() - 91 * 86_400_000) } })
  await loginAsAdmin(page)
  const url = await createLinkAsSeller(page, data.contact.id, "Project approver")
  const { page: guest, context } = await visitor(browser)
  await guest.goto(url)
  await waitForClientReady(guest)
  // The open agreement is still awaiting its decision; the expired delivery is not counted.
  await expect(guest.getByTestId("client-action-summary")).toHaveText("Waiting for you: 1")
  await expect(guest.getByText("Review expired", { exact: true })).toBeVisible()
  await guest.getByRole("link", { name: "View delivery", exact: true }).click()
  await expect(guest.getByText("Review expired", { exact: true })).toBeVisible()
  await expect(guest.getByText(/The 90-day review period has ended. Contact E2E Org/)).toBeVisible()
  await expect(guest.getByRole("button", { name: "Accept delivery", exact: true })).toHaveCount(0)
  await expect(guest.getByRole("button", { name: "Request changes", exact: true })).toHaveCount(0)
  await screenshot(guest, "delivery-review-expired")
  await guest.reload()
  await expect(guest.getByText("Review expired", { exact: true })).toBeVisible()
  const link = await prisma.clientActionLink.findFirstOrThrow({ where: { verification: "email_code" } })
  // Same seller renewal command used by the management UI, with its existing grants intact.
  const { renewClientLink } = await import("../../src/domain/commands/client-links")
  const actor = (await resolveUserActor({ organizationId: data.setup.organizationId, userId: data.setup.adminUserId! }))!
  completed(await executeCommand(renewClientLink, { id: link.id, expiresInDays: 90 }, { actor }))
  await guest.reload()
  await expect(guest.getByText("Review expired", { exact: true })).toBeVisible()
  await expect(guest.getByRole("button", { name: "Accept delivery", exact: true })).toHaveCount(0)
  expect(await prisma.deliverable.findUniqueOrThrow({ where: { id: data.line.id } })).toMatchObject({ status: "delivered", acceptedAt: null })
  await context.close()
})

test("a delayed delivery response cannot replace a newer agreement page", async ({ page, browser }) => {
  const data = await seed()
  await loginAsAdmin(page)
  const url = await createLinkAsSeller(page, data.contact.id, "Project approver")
  const { page: approver, context } = await visitor(browser)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let received = false
  try {
    await approver.goto(url)
    await waitForClientReady(approver)
    await approver.getByRole("link", { name: "Review and sign off" }).click()
    await approver.getByRole("button", { name: "Email me a code" }).click()
    await expect.poll(() => capturedMessages().length).toBe(1)
    await approver.getByLabel("Six-digit code").fill(capturedMessages()[0]!.html.match(/>(\d{6})</)![1]!)
    await approver.getByRole("button", { name: "Verify", exact: true }).click()
    await expect(approver.getByRole("heading", { name: "Confirm it is you before approving" })).toHaveCount(0)

    // Execute the actual command, then hold only its HTTP response. UI supersession must not
    // be mistaken for cancellation or rollback of the completed server decision.
    await approver.route("**/_serverFn/**", async (route) => {
      if (!route.request().postData()?.includes("deliverable.accept")) { await route.continue(); return }
      const response = await route.fetch()
      received = true
      await held
      await route.fulfill({ response })
    })
    await approver.getByRole("checkbox", { name: "I have reviewed and accept this delivery." }).check()
    await approver.getByRole("button", { name: "Accept delivery", exact: true }).click()
    await expect.poll(() => received).toBe(true)
    expect(await prisma.deliverable.findUniqueOrThrow({ where: { id: data.line.id } })).toMatchObject({ status: "accepted", acceptedRevision: 1 })
    await approver.getByRole("link", { name: "Back to your documents" }).click()
    await approver.getByRole("link", { name: "Review and decide" }).click()
    await expect(approver).toHaveURL(new RegExp(`item=agreement(:|%3A)${data.open.id}`))
    await expect(approver.getByLabel("Your full name")).toBeVisible()
    const finished = approver.waitForEvent("requestfinished", { predicate: (request) => request.postData()?.includes("deliverable.accept") ?? false })
    release()
    await finished
    // Let React process the response before asserting the visible record and notice.
    await approver.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(approver.getByLabel("Your full name")).toBeVisible()
    await expect(approver.getByText("Thank you. The delivery is signed off.")).toHaveCount(0)
    await expect(approver.getByRole("button", { name: "Accept delivery", exact: true })).toHaveCount(0)
    await screenshot(approver, "deferred-delivery-new-agreement")
  } finally {
    release()
    await approver.unrouteAll({ behavior: "wait" })
    await context.close()
  }
})

test("a code response superseded by payment leaves no stale gate message", async ({ page, browser }) => {
  const data = await seed()
  await loginAsAdmin(page)
  await page.goto(`/contacts/${data.contact.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Create client link", exact: true }).click()
  await page.getByRole("button", { name: "Project approver", exact: true }).click()
  await page.getByLabel("INV-CLIENT-0001", { exact: true }).selectOption("pay")
  await page.getByRole("button", { name: "Create link", exact: true }).click()
  const url = await page.getByTestId("created-client-link").getByRole("textbox").inputValue()
  const { page: guest, context } = await visitor(browser)
  let releaseCode!: () => void, releasePayment!: () => void
  const heldCode = new Promise<void>((resolve) => { releaseCode = resolve })
  const heldPayment = new Promise<void>((resolve) => { releasePayment = resolve })
  let codeReceived = false, paymentReceived = false
  try {
    await guest.goto(`${url}?item=invoice:${data.invoice.id}`)
    await waitForClientReady(guest)
    const gate = guest.getByRole("region", { name: "Confirm it is you before approving" })
    const pay = guest.getByRole("button", { name: "Pay now", exact: true })
    await expect(pay).toBeEnabled()
    await gate.getByRole("button", { name: "Email me a code" }).click()
    await expect.poll(() => capturedMessages().length).toBe(1)
    const code = capturedMessages()[0]!.html.match(/>(\d{6})</)![1]!
    await gate.getByLabel("Six-digit code").fill(code)

    // The initial page offers Pay. Removing synthetic credentials now exercises the real
    // unavailable response without contacting a payment provider.
    await prisma.orgSettings.update({ where: { organizationId: data.setup.organizationId }, data: { stripeSecretKeyEnc: null } })
    await guest.route("**/_serverFn/**", async (route) => {
      const body = route.request().postData() ?? ""
      if (body.includes('"code"')) {
        codeReceived = true
        await heldCode
        await route.fulfill({ response: await route.fetch() })
      } else if (body.includes("invoice.pay")) {
        // Take the real payment snapshot before the verification cookie is issued.
        const response = await route.fetch()
        paymentReceived = true
        await heldPayment
        await route.fulfill({ response })
      } else await route.continue()
    })
    await gate.getByRole("button", { name: "Verify", exact: true }).click()
    await expect.poll(() => codeReceived).toBe(true)
    await pay.click()
    await expect.poll(() => paymentReceived).toBe(true)
    await expect(pay).toBeDisabled()

    const codeFinished = guest.waitForEvent("requestfinished", { predicate: (request) => request.postData()?.includes('"code"') ?? false })
    releaseCode()
    await codeFinished
    // Enabled Verify proves the old continuation and its finally have run, not just the network.
    await expect(gate.getByRole("button", { name: "Verify", exact: true })).toBeEnabled()
    await expect(gate.getByRole("status")).toHaveText("")
    await expect(pay).toBeDisabled()
    expect((await context.cookies()).some((cookie) => cookie.name.startsWith("qca_"))).toBe(true)
    await screenshot(guest, "superseded-code-payment-pending")

    releasePayment()
    await expect(guest.getByRole("alert")).toHaveText("This can no longer be done.")
    await expect(gate).toBeVisible()
    await expect(gate.getByRole("status")).toHaveText("")
    expect(await prisma.clientActionLink.findFirstOrThrow({ where: { verification: "email_code" } })).toMatchObject({ revokedAt: null })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: data.invoice.id } })).toMatchObject({ stripeCheckoutSessionId: null, paymentStatus: "unpaid" })
    await screenshot(guest, "superseded-code-current-payment-notice")

    // Discarding feedback did not roll back verification on the server. A new code and current
    // verification still refresh this page normally after the payment refusal.
    await gate.getByRole("button", { name: "Send a new code" }).click()
    await expect.poll(() => capturedMessages().length).toBe(2)
    await gate.getByLabel("Six-digit code").fill(capturedMessages()[1]!.html.match(/>(\d{6})</)![1]!)
    await gate.getByRole("button", { name: "Verify", exact: true }).click()
    await expect(gate).toHaveCount(0)
    await expect(guest.getByRole("alert")).toHaveCount(0)
  } finally {
    releaseCode()
    releasePayment()
    await guest.unrouteAll({ behavior: "wait" })
    await context.close()
  }
})
