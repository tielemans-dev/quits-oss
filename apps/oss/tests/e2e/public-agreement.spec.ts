import { createServer, type Server } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { resetDatabase, seedPublicQuote, seedCompletedSetup, loginAsAdmin, waitForClientReady } from "./support"
let provider: Server
const messages: Array<{ to: string; html: string }> = []
test.beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    messages.push(JSON.parse(body))
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: `synthetic-email-${messages.length}` }))
  })
  await new Promise<void>((resolve) => provider.listen(3059, "127.0.0.1", resolve))
})
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  )
})
test.beforeEach(async () => {
  await resetDatabase()
  messages.length = 0
})
async function createDraftInUi(page: Page, title: string, withSchedule = false) {
  await page.goto("/agreements/new")
  await waitForClientReady(page)
  await page.getByLabel("Title", { exact: true }).fill(title)
  await page.getByLabel("Customer", { exact: true }).click()
  await page.getByRole("option", { name: "Agreement Customer" }).click()
  await page.getByLabel("Valid until", { exact: true }).click()
  await page.getByRole("button", { name: "Go to the Next Month" }).click()
  await page
    .getByRole("gridcell")
    .filter({ has: page.getByRole("button", { name: /\b20(?:th)?\b/ }) })
    .first()
    .getByRole("button")
    .click()
  await page.getByLabel("Deliverable title", { exact: true }).fill("Website delivery")
  await page.getByLabel("Description", { exact: true }).fill("Build the agreed website")
  await page.getByLabel("Unit price", { exact: true }).fill("700")
  await page
    .getByLabel("Terms (Markdown)", { exact: true })
    .fill(
      "# Scope\n\n**Website work** for {{buyer.name}}.\n\n[x](javascript:alert%281%29)\n<script>alert(1)</script>",
    )
  if (withSchedule) {
    await page.getByRole("button", { name: "Add deliverable", exact: true }).click()
    await page.getByLabel("Deliverable title", { exact: true }).nth(1).fill("Initial payment")
    await page.getByLabel("Description", { exact: true }).nth(1).fill("Payment on agreement acceptance")
    await page.getByLabel("Unit price", { exact: true }).nth(1).fill("100")
    await page.getByLabel("Payment schedule line", { exact: true }).nth(1).check()
  }
  await page.getByRole("button", { name: "Save draft", exact: true }).click()
  await expect(page).toHaveURL(/\/agreements\/[^/]+$/)
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible()
}
test("create, send, accept, inspect acceptance record and PDF; recall invalidates the customer link", async ({
  page,
  browser,
}) => {
  const setup = await seedCompletedSetup()
  await prisma.contact.create({
    data: {
      organizationId: setup.organizationId,
      name: "Agreement Customer",
      email: "customer@example.test",
    },
  })
  await loginAsAdmin(page)
  await createDraftInUi(page, "Browser agreement")
  const id = new URL(page.url()).pathname.split("/").at(-1)!
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("link", { name: "Open customer link" })).toBeVisible()
  const url = await page.getByRole("link", { name: "Open customer link" }).getAttribute("href")
  expect(messages).toHaveLength(1)
  expect(messages[0]!.to).toBe("customer@example.test")
  expect(messages[0]!.html).toContain(url)
  expect((await prisma.agreement.findUniqueOrThrow({ where: { id } })).status).toBe("sent")
  const customerContext = await browser.newContext()
  const customer = await customerContext.newPage()
  await customer.goto(url!)
  await waitForClientReady(customer)
  await customer.getByLabel("Your full name").fill("Customer Signer")
  await customer.getByRole("checkbox").check()
  await customer.getByRole("button", { name: "Accept agreement", exact: true }).click()
  await expect(customer.getByRole("heading", { name: "Acceptance record" })).toBeVisible()
  await expect(customer.getByText("Your full name: Customer Signer")).toBeVisible()
  const pdfUrl = await customer.getByRole("link", { name: "Download PDF" }).getAttribute("href")
  const pdf = await customer.request.get(pdfUrl!)
  expect(pdf.status()).toBe(200)
  expect(pdf.headers()["content-type"]).toBe("application/pdf")
  const body = await pdf.body()
  expect(body.subarray(0, 4).toString()).toBe("%PDF")
  await mkdir("/var/tmp/quits-agreements-1b", { recursive: true })
  await writeFile("/var/tmp/quits-agreements-1b/accepted-agreement.pdf", body)
  await customer.setViewportSize({ width: 390, height: 844 })
  expect(await customer.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Acceptance record" })).toBeVisible()
  expect(messages).toHaveLength(3)
  await createDraftInUi(page, "Recall agreement")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("link", { name: "Open customer link" })).toBeVisible()
  const recalledUrl = await page
    .getByRole("link", { name: "Open customer link" })
    .getAttribute("href")
  await page.getByRole("button", { name: "Recall", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Recall", exact: true }).click()
  await expect(page.getByRole("link", { name: "Edit draft" })).toBeVisible()
  await customer.goto(recalledUrl!)
  await expect(
    customer.getByRole("heading", { name: "This link is no longer valid" }),
  ).toBeVisible()
  await writeFile(
    "/var/tmp/quits-agreements-1b/browser-evidence.json",
    JSON.stringify(
      {
        acceptedUrl: new URL(pdfUrl!.replace(/\/pdf$/, ""), page.url()).href,
        recalledUrl,
        agreementId: id,
      },
      null,
      2,
    ),
  )
  await customerContext.close()
})

test("accept, deliver, sign off, reserve and send an invoice from the agreement", async ({ page, browser }) => {
  const setup = await seedCompletedSetup()
  await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Agreement Customer", email: "customer@example.test" } })
  await loginAsAdmin(page)
  await createDraftInUi(page, "Phase 2 browser agreement", true)
  const agreementId = new URL(page.url()).pathname.split("/").at(-1)!
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const customerLink = page.getByRole("link", { name: "Open customer link" })
  await expect(customerLink).toBeVisible()
  const url = await customerLink.getAttribute("href")
  const customerContext = await browser.newContext(), customer = await customerContext.newPage()
  await customer.goto(url!)
  await waitForClientReady(customer)
  await expect(customer.getByRole("heading", { name: "Payment schedule", exact: true })).toBeVisible()
  await expect(customer.getByText(/Service total/)).toBeVisible()
  await customer.getByLabel("Your full name").fill("Phase 2 customer")
  await customer.getByRole("checkbox").check()
  await customer.getByRole("button", { name: "Accept agreement", exact: true }).click()
  await expect(customer.getByRole("heading", { name: "Acceptance record" })).toBeVisible()
  await page.reload()
  const deliverable = page.getByRole("group", { name: "Website delivery", exact: true })
  await expect(deliverable.getByText("Unbilled", { exact: true })).toBeVisible()
  await deliverable.getByRole("button", { name: "Mark delivered", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Mark delivered", exact: true }).click()
  await deliverable.locator("summary").filter({ hasText: "Record acceptance" }).click()
  await deliverable.getByLabel("Evidence note (required)").fill("Customer accepted the finished website")
  await deliverable.getByRole("button", { name: "Record acceptance", exact: true }).click()
  await expect(deliverable.getByText("Accepted", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Invoice", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: /Website delivery/ })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: /Initial payment/ })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: /Invoice these schedule/ })).not.toBeChecked()
  await page.getByRole("button", { name: "Create draft invoices", exact: true }).click()
  await expect(deliverable.getByText("Reserved", { exact: true })).toBeVisible()
  const saleHref = await page.getByRole("link", { name: "Open sale invoice", exact: true }).getAttribute("href")
  await page.getByRole("link", { name: "Open prepayment draft", exact: true }).click()
  await expect(page.getByText("Prepayment drafts cannot be issued yet. You can explicitly invoice a schedule line as a sale instead.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0)
  const prepaymentId = new URL(page.url()).pathname.split("/").at(-1)!
  await page.getByRole("button", { name: "Invoice schedule as sale", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Invoice schedule as sale", exact: true }).click()
  await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: prepaymentId } })).purpose).toBe("sale")
  expect((await prisma.invoice.findUniqueOrThrow({ where: { id: prepaymentId } })).scheduleSaleChoice).toMatchObject({ deliverableIds: [expect.any(String)] })
  await page.goto(saleHref!)
  await expect(page).toHaveURL(/\/invoices\/[^/]+$/)
  const invoiceId = new URL(page.url()).pathname.split("/").at(-1)!
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("sent")
  await page.goto(`/agreements/${agreementId}`)
  await expect(page.getByRole("group", { name: "Website delivery", exact: true }).getByText("Invoiced", { exact: true })).toBeVisible()
  const line = await prisma.deliverable.findFirstOrThrow({ where: { agreementId, isDeposit: false } })
  expect(line).toMatchObject({ status: "accepted", billingStatus: "invoiced" })
  await mkdir("/var/tmp/quits-agreements-phase2", { recursive: true })
  await page.screenshot({ path: "/var/tmp/quits-agreements-phase2/invoiced-agreement.png", fullPage: true })
  await writeFile("/var/tmp/quits-agreements-phase2/browser-evidence.json", JSON.stringify({ agreementId, invoiceId, customerAccepted: true, fulfillment: line.status, billing: line.billingStatus, emailMessages: messages.length }, null, 2))
  await customerContext.close()
})

async function acceptedCustomerDelivery(page: Page, customer: Page, title: string) {
  await createDraftInUi(page, title)
  const agreementId = new URL(page.url()).pathname.split("/").at(-1)!
  // Choose delivery billing on the draft; issuance freezes this setting.
  await prisma.agreement.update({ where: { id: agreementId }, data: { billingTrigger: "on_delivery" } })
  await page.reload()
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const link = page.getByRole("link", { name: "Open customer link" })
  await expect(link).toBeVisible()
  await customer.goto((await link.getAttribute("href"))!)
  await waitForClientReady(customer)
  await customer.getByLabel("Your full name").fill("Phase 3 customer")
  await customer.getByRole("checkbox").check()
  await customer.getByRole("button", { name: "Accept agreement", exact: true }).click()
  await expect(customer.getByRole("heading", { name: "Acceptance record" })).toBeVisible()
  await page.reload()
  const group = page.getByRole("group", { name: "Website delivery", exact: true })
  await group.getByRole("button", { name: "Mark delivered", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText("customer@example.test")
  await page.getByRole("alertdialog").getByRole("button", { name: "Mark delivered", exact: true }).click()
  const signOff = group.getByRole("link", { name: "Open customer sign-off link" })
  await expect(signOff).toBeVisible()
  const url = (await signOff.getAttribute("href"))!
  await expect.poll(() => messages.some(message => message.to === "customer@example.test" && message.html.includes(url))).toBe(true)
  await customer.goto(url)
  await waitForClientReady(customer)
  return { agreementId, group, url }
}

for (const decision of ["accept", "changes"] as const) test(`Phase 3 deliver, customer ${decision}; disputed send requires acknowledgement`, async ({ page, browser }) => {
  const setup = await seedCompletedSetup()
  await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Agreement Customer", email: "customer@example.test" } })
  await loginAsAdmin(page)
  const context = await browser.newContext(), customer = await context.newPage()
  const { agreementId, group, url } = await acceptedCustomerDelivery(page, customer, `Phase 3 ${decision}`)
  if (decision === "accept") {
    await customer.getByRole("checkbox").check()
    await customer.getByRole("button", { name: "Accept delivery", exact: true }).click()
    await expect(customer.getByText("Accepted", { exact: true })).toBeVisible()
    await page.reload()
    await expect(group.getByText("Accepted", { exact: true })).toBeVisible()
    const line = await prisma.deliverable.findFirstOrThrow({ where: { agreementId } })
    expect(line).toMatchObject({ acceptedRevision: 1, acceptedVia: "customer_link" })
  } else {
    await page.getByRole("button", { name: "Invoice", exact: true }).click()
    await page.getByRole("button", { name: "Create draft invoices", exact: true }).click()
    await expect(group.getByText("Reserved", { exact: true })).toBeVisible()
    const invoiceHref = (await page.getByRole("link", { name: "Open sale invoice", exact: true }).getAttribute("href"))!
    await customer.getByLabel("Requested changes (required)").fill("Please make the heading larger")
    await customer.getByRole("button", { name: "Request changes", exact: true }).click()
    await expect(customer.getByText("Changes requested", { exact: true })).toBeVisible()
    await expect(customer.getByText("Please make the heading larger", { exact: true })).toBeVisible()
    await page.reload()
    await expect(group.getByText("Please make the heading larger", { exact: true })).toBeVisible()
    await page.goto(invoiceHref)
    await waitForClientReady(page)
    const invoiceId = new URL(page.url()).pathname.split("/").at(-1)!
    await expect(page.getByText("The customer requested changes to work on this draft. Sending requires explicit acknowledgement.", { exact: true })).toBeVisible()
    const emailsBeforeSend = messages.length
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page.getByRole("alert")).toContainText(/acknowledge/i)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("draft")
    expect(messages.length).toBe(emailsBeforeSend)
    await page.getByRole("checkbox", { name: "I acknowledge the requested changes and want to send this disputed draft.", exact: true }).check()
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("sent")
    expect(await prisma.domainEvent.findFirst({ where: { aggregateId: invoiceId, type: "invoice.dispute_acknowledged" } })).toMatchObject({ payload: { acknowledgeDisputed: true } })
    await page.goto(`/agreements/${agreementId}`)
    await group.getByRole("button", { name: "Re-deliver", exact: true }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Mark delivered", exact: true }).click()
    await expect(group.getByText("Delivery revision: 2", { exact: true })).toBeVisible()
    await customer.goto(url)
    await expect(customer.getByRole("heading", { name: "This link is no longer valid" })).toBeVisible()
  }
  await context.close()
})


test("accepted quote creates an agreement draft, blocks direct invoicing and sends the reviewed offer", async ({ page, browser }) => {
  const quote = await seedPublicQuote()
  await prisma.quote.update({ where: { id: quote.id }, data: { expiryDate: new Date("2099-12-01") } })
  const context = await browser.newContext(), customer = await context.newPage()
  await customer.goto(quote.url)
  await waitForClientReady(customer)
  await customer.getByRole("button", { name: "Accept quote", exact: true }).click()
  await expect(customer.getByText("Quote accepted", { exact: true })).toBeVisible()
  await loginAsAdmin(page)
  await page.goto(`/quotes/${quote.id}`)
  await waitForClientReady(page)
  await expect(page.getByRole("button", { name: "Convert to Invoice", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Create agreement", exact: true }).click()
  await page.getByLabel("Valid until", { exact: true }).click()
  await page.getByRole("button", { name: "Go to the Next Month" }).click()
  await page.getByRole("gridcell").filter({ has: page.getByRole("button", { name: /\b20(?:th)?\b/ }) }).first().getByRole("button").click()
  await page.getByRole("button", { name: "Save draft", exact: true }).click()
  await expect(page).toHaveURL(/\/agreements\/[^/]+\/edit$/)
  const agreementId = new URL(page.url()).pathname.split("/").at(-2)!
  await expect(page.getByLabel("Deliverable title", { exact: true })).toHaveValue("Strategy session")
  await expect(page.getByLabel("Unit price", { exact: true })).toHaveValue("100")
  await page.getByRole("button", { name: "Save draft", exact: true }).click()
  await expect(page).toHaveURL(/\/agreements\/[^/]+$/)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("link", { name: "Open customer link" })).toBeVisible()
  expect((await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } })).status).toBe("sent")
  expect(messages.some(message => message.to === "quote-customer@example.com")).toBe(true)
  await page.goto(`/quotes/${quote.id}`)
  await expect(page.getByRole("button", { name: "Convert to Invoice", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Create agreement", exact: true })).toBeDisabled()
  await expect(page.getByText(/This quote already has an agreement/)).toBeVisible()
  await context.close()
})

test("template editor creates, updates and deletes templates", async ({ page }) => {
  await seedCompletedSetup()
  await loginAsAdmin(page)
  await page.goto("/agreements")
  await waitForClientReady(page)
  await page.locator("summary").filter({ hasText: "Manage templates" }).click()
  await page.getByLabel("Template name", { exact: true }).fill("Browser template")
  await page.getByLabel("Terms (Markdown)", { exact: true }).fill("Original {{buyer.name}} terms")
  await page.getByRole("checkbox", { name: "Use as default template", exact: true }).check()
  await page.getByRole("button", { name: "Save template", exact: true }).click()
  await expect(page.getByRole("option", { name: "Browser template", exact: true })).toHaveCount(1)
  const template = await prisma.agreementTemplate.findFirstOrThrow({ where: { name: "Browser template" } })
  await page.getByLabel("Template", { exact: true }).selectOption(template.id)
  await page.getByLabel("Terms (Markdown)", { exact: true }).fill("Revised {{buyer.name}} terms")
  await page.getByRole("button", { name: "Save template", exact: true }).click()
  await expect.poll(async () => (await prisma.agreementTemplate.findUniqueOrThrow({ where: { id: template.id } })).termsMarkdown).toBe("Revised {{buyer.name}} terms")
  await expect(page.getByLabel("Template name", { exact: true })).toHaveValue("")
  await page.getByLabel("Template", { exact: true }).selectOption(template.id)
  await page.getByRole("button", { name: "Delete template", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete template", exact: true }).click()
  await expect.poll(() => prisma.agreementTemplate.count({ where: { id: template.id } })).toBe(0)
})
