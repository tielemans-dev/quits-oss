import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { composeInvoiceEmail } from "../../src/domain/documents/invoice-email"
import { translate } from "../../src/lib/i18n/translate"
import { waitForClientReady } from "./support"

// MOCK: captures only synthetic fixtures in the disposable CI database enforced by the config.
const revision = process.env.QUI62_EVIDENCE_REVISION === "baseline" ? "baseline" : "after"
export async function captureDocument(page: Page, surface: string, locale: string, html: string) {
  await writeFile(test.info().outputPath(`${surface}-${locale}-${revision}.html`), html)
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    for (const [device, width] of [["desktop", 1440], ["mobile390", 390]] as const) {
      await page.setViewportSize({ width, height: 1100 })
      await page.setContent(html)
      await page.screenshot({ path: test.info().outputPath(`${surface}-${locale}-${colorScheme}-${device}-${revision}.png`), fullPage: true })
    }
  }
}
export async function capturePdf(page: Page, kind: "invoice" | "creditNote", id: string, locale: string,
  evidence: { scenario?: string; minPages?: number; expectedText?: string[]; footerText?: string[]; artifact?: "stored" | "live" } = {}) {
  const response = await page.request.get(`/api/documents/${kind}/${id}/pdf`)
  expect(response.ok(), `PDF export returned HTTP ${response.status()}`).toBe(true)
  const bytes = await response.body()
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-")
  expect(response.headers()["x-quits-artifact"]).toBe(evidence.artifact ?? "stored")
  const surface = evidence.scenario ? `${kind}-${evidence.scenario}` : kind
  const prefix = test.info().outputPath(`${surface}-pdf-${locale}-${revision}`)
  await writeFile(`${prefix}.pdf`, bytes)
  // Poppler renders the actual export. The screenshot is an A4 preview scaled to each viewport.
  execFileSync("pdftoppm", ["-png", "-r", "100", `${prefix}.pdf`, prefix])
  const text = execFileSync("pdftotext", ["-layout", `${prefix}.pdf`, "-"], { encoding: "utf8" })
  const pages = text.split("\f").filter(value => value.trim())
  const footers = pages.map((value, index) => ({ page: index + 1,
    expected: translate("pdf.pageNumber", locale, { page: index + 1, total: pages.length }),
    text: value,
  }))
  // Keep the per-page text audit alongside the rendered exports.
  await writeFile(`${prefix}-text-audit.json`, JSON.stringify({ kind, id, locale, scenario: evidence.scenario,
    pages: footers.map(value => ({ ...value, footerPresent: value.text.includes(value.expected) })),
  }, null, 2))
  expect(pages.length).toBeGreaterThanOrEqual(evidence.minPages ?? 1)
  const searchableText = text.replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2").replace(/\s+/g, " ")
  for (const expected of evidence.expectedText ?? []) expect(searchableText).toContain(expected)
  for (const footer of footers) {
    expect(footer.text).toContain(footer.expected)
    for (const expected of evidence.footerText ?? []) expect(footer.text).toContain(expected)
  }
  for (let index = 0; index < pages.length; index++) {
    const png = await readFile(`${prefix}-${index + 1}.png`)
    const preview = index === 0 ? `${surface}-pdf-preview` : `${surface}-pdf-preview-page${index + 1}`
    await captureDocument(page, preview, locale, `<html><body style="margin:0;background:white"><img alt="Exported PDF page ${index + 1}" style="display:block;width:100%;max-width:827px;margin:auto" src="data:image/png;base64,${png.toString("base64")}" /></body></html>`)
  }
}
export async function captureInvoiceEmail(page: Page, invoiceId: string, organizationId: string, locale: string, publicPaymentUrl: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { contact: true, items: { orderBy: { sortOrder: "asc" } } } })
  const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId } })
  if (!invoice.number) throw new Error("Evidence requires an issued synthetic invoice")
  const html = composeInvoiceEmail({ invoice: { ...invoice, number: invoice.number }, settings, to: "buyer@example.test", publicPaymentUrl }).message.html
  expect(html.split(translate("pdf.nonVatRegistered", locale))).toHaveLength(2)
  await captureDocument(page, "invoice-email", locale, html)
}
export async function captureOnboarding(page: Page, organizationId: string, locale: string) {
  // MOCK: remove this test user's membership and active organization to show the real OSS creation page.
  const cleared = await page.request.post("/api/auth/organization/set-active", { data: { organizationId: null }, headers: { origin: "http://127.0.0.1:3040" } })
  expect(cleared.ok()).toBe(true)
  await prisma.member.deleteMany({ where: { organizationId } })
  await prisma.session.updateMany({ data: { activeOrganizationId: null } })
  await page.addInitScript(language => Object.defineProperty(navigator, "language", { value: language }), locale)
  await page.goto("/onboarding")
  await waitForClientReady(page)
  await expect(page.getByLabel(translate("auth.onboarding.field.companyName", locale), { exact: true })).toBeVisible()
  expect(await page.getByRole("radio").count()).toBe(0)
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.evaluate(() => localStorage.setItem("quits-theme", "system"))
    await page.reload()
    await waitForClientReady(page)
    await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /dark/ : /^(?!.*\bdark\b)/)
    for (const [device, width] of [["desktop", 1440], ["mobile390", 390]] as const) {
      await page.setViewportSize({ width, height: 1100 })
      await page.screenshot({ path: test.info().outputPath(`onboarding-organization-creation-${locale}-${colorScheme}-${device}-${revision}.png`), fullPage: true })
    }
  }
  await writeFile(test.info().outputPath(`onboarding-evidence-gap-${locale}.txt`), "OSS /onboarding organization creation only. This route has no VAT registration confirmation control. Kai/Ines require separate confirmation evidence from its owning integration.\n")
}

/** Synthetic hosted extension evidence. This is not evidence for a released private consumer. */
export async function captureHostedOnboarding(page: Page, organizationId: string, locale: string, registered = false) {
  // Existing documents forbid rerunning confirmV2. Use a fresh synthetic organization.
  const response = await page.request.post("/api/auth/organization/create", {
    headers: { origin: "http://127.0.0.1:3040" }, data: { name: "Synthetic Review", slug: `review-${crypto.randomUUID()}` },
  })
  expect(response.ok()).toBe(true)
  const organization = await response.json() as { id: string }
  const active = await page.request.post("/api/auth/organization/set-active", { headers: { origin: "http://127.0.0.1:3040" }, data: { organizationId: organization.id } })
  expect(active.ok()).toBe(true)
  await prisma.orgSettings.upsert({ where: { organizationId: organization.id }, create: { organizationId: organization.id, locale, onboardingStatus: "in_progress" }, update: { locale, onboardingStatus: "in_progress", onboardingCompletedAt: null } })
  await page.goto("/onboarding")
  await waitForClientReady(page)
  await page.getByRole("textbox", { name: translate("onboardingV2.search.heading", locale), exact: true }).fill("Synthetic")
  await page.getByRole("button").filter({ hasText: "Synthetic Seller" }).click()
  await expect(page.getByLabel(translate("onboardingV2.field.cvr", locale), { exact: true })).toHaveValue("24256790")
  const yes = page.getByRole("radio", { name: translate("vatStatus.yes", locale), exact: true })
  const no = page.getByRole("radio", { name: translate("vatStatus.no", locale), exact: true })
  await expect(yes).not.toBeChecked(); await expect(no).not.toBeChecked()
  await page.screenshot({ path: test.info().outputPath(`onboarding-hosted-review-${locale}.png`), fullPage: true })
  await (registered ? yes : no).check()
  await page.getByLabel(translate("onboardingV2.bank.reg", locale), { exact: true }).fill("0040")
  await page.getByLabel(translate("onboardingV2.bank.account", locale), { exact: true }).fill("0440116243")
  await page.getByRole("button", { name: translate("onboardingV2.confirm", locale), exact: true }).click()
  await expect.poll(async () => (await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: organization.id } })).onboardingStatus).toBe("complete")
  const saved = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: organization.id } })
  expect(saved.momsRegistered).toBe(registered)
  if (saved.taxRate === null) throw new Error("Completed synthetic onboarding must save its explicit tax rate")
  expect(saved.taxRate.toNumber()).toBe(registered ? 25 : 0)
  expect(organization.id).not.toBe(organizationId)
  return organization.id
}
