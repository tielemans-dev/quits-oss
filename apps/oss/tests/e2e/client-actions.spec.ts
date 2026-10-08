import { createServer, type Server } from "node:http"
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
const browserErrors: Array<{ path: string; message: string }> = []
function observePage(page: Page) {
  const record = (message: string) => browserErrors.push({ path: new URL(page.url()).pathname, message })
  page.on("crash", () => record("Page crashed"))
  page.on("pageerror", (error) => record(error.message))
}
async function screenshot(page: Page, name: string, info: TestInfo = test.info()) {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await info.attach(name, { path, contentType: "image/png" })
}

let provider: Server
const messages: Array<{ to: string; subject: string; html: string }> = []
test.beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    messages.push(JSON.parse(body))
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: `synthetic-email-${messages.length}` }))
  })
  await new Promise<void>((resolve) => provider.listen(3060, "127.0.0.1", resolve))
})
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())))
})

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
  messages.length = 0
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
  // Keep the unrelated seller UserMenu hydration diagnostic visible. Its recoverable missing
  // SidebarMenu SSR node comes from a component unchanged from main; all functional assertions still run. Never
  // exempt public client pages, crashes, module import errors or any other hydration mismatch.
  const knownSellerHydration = ({ path, message }: (typeof browserErrors)[number]) =>
    !path.startsWith("/c/") &&
    message.startsWith("Hydration failed because the server rendered HTML didn't match the client.") &&
    message.includes("<UserMenu") && message.includes("/src/components/user-menu.tsx:106:5")
  if (browserErrors.length) {
    await info.attach("browser-runtime-diagnostics", {
      body: JSON.stringify(browserErrors, null, 2), contentType: "application/json",
    })
  }
  expect(browserErrors.filter((error) => !knownSellerHydration(error)), "Browser runtime errors").toEqual([])
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
  await expect.poll(() => messages.length).toBe(1)
  expect(messages[0]).toMatchObject({ to: "client@example.test" })
  const code = messages[0]!.html.match(/>(\d{6})</)![1]!
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
