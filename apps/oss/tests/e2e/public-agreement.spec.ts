import { createServer, type Server } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { resetDatabase, seedCompletedSetup, loginAsAdmin, waitForClientReady } from "./support"
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
async function createDraftInUi(page: Page, title: string) {
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
