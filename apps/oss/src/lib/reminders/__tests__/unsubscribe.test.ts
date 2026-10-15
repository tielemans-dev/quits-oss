import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildInvoiceEmailContent, buildQuoteEmailContent, composeMessage } from "../../email"
import { addReminderUnsubscribe, automaticReminderSuppressed, postReminderUnsubscribe, readReminderUnsubscribeState, reminderUnsubscribeState, type ReminderPreferenceDb } from "../unsubscribe"
import { signReminderUnsubscribeToken } from "../unsubscribe-token"
import { appLogger } from "../../observability"

const secret = "test-reminder-secret-with-at-least-32-characters"
const binding = { id: "ca4bc3d8-4371-4af0-9c03-6f2971a3c223", organizationId: "org-one", recipient: "buyer@example.test", locale: "da-DK", unsubscribedAt: null as Date | null }

function fixture() {
  const row = { ...binding }
  const findUnique = vi.fn(async ({ where }: { where: { id?: string; organizationId_recipient?: { organizationId: string; recipient: string } } }) => {
    const key = where.organizationId_recipient
    return where.id === row.id || (key?.organizationId === row.organizationId && key.recipient === row.recipient) ? { ...row } : null
  })
  const updateMany = vi.fn(async ({ where, data }: { where: { unsubscribedAt: null | { not: null } }; data: { unsubscribedAt: Date | null } }) => {
    if (where.unsubscribedAt === null && row.unsubscribedAt !== null) return { count: 0 }
    if (where.unsubscribedAt?.not === null && row.unsubscribedAt === null) return { count: 0 }
    row.unsubscribedAt = data.unsubscribedAt
    return { count: 1 }
  })
  const upsert = vi.fn(async () => ({ ...row }))
  const db = { recipientReminderPreference: { findUnique, updateMany, upsert }, organization: { findUnique: vi.fn(async () => ({ name: 'Seller <one>' })) } } as unknown as ReminderPreferenceDb
  return { row, db, findUnique, updateMany, upsert }
}

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", secret)
  vi.stubEnv("QUITS_REMINDER_UNSUBSCRIBE_SECRET", undefined)
  vi.stubEnv("YAIP_REMINDER_UNSUBSCRIBE_SECRET", undefined)
  vi.stubEnv("QUITS_APP_ORIGIN", "https://app.example.test")
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe("reminder unsubscribe state and POST", () => {
  it("keeps repeated GETs read-only and POSTs idempotent, using stored locale", async () => {
    const { row, db, updateMany } = fixture()
    const token = signReminderUnsubscribeToken(row, secret)
    for (let i = 0; i < 2; i++) expect(await readReminderUnsubscribeState(db, token, "en")).toMatchObject({ kind: "confirm", locale: "da-DK" })
    expect(updateMany).not.toHaveBeenCalled()
    expect(row.unsubscribedAt).toBeNull()
    expect(await reminderUnsubscribeState(db, token, "POST")).toMatchObject({ kind: "done" })
    const first = row.unsubscribedAt
    expect(await reminderUnsubscribeState(db, token, "POST")).toMatchObject({ kind: "done" })
    expect(row.unsubscribedAt).toBe(first)
    expect(await readReminderUnsubscribeState(db, token)).toMatchObject({ kind: "done" })
    expect(await readReminderUnsubscribeState(db, token)).toMatchObject({ kind: "done" })
  })

  it("resumes only through an explicit recipient form POST and keeps one-click unsubscribe-only", async () => {
    const { row, db, updateMany } = fixture()
    row.unsubscribedAt = new Date()
    const token = signReminderUnsubscribeToken(row, secret)
    const post = (url: string, data: Record<string, string>) => new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) })
    const url = "https://app.example.test/reminders/unsubscribe"
    const stoppedAt = row.unsubscribedAt
    expect((await postReminderUnsubscribe(post(`${url}?token=${token}`, { "List-Unsubscribe": "One-Click", intent: "resume" }), db, true)).status).toBe(204)
    expect(row.unsubscribedAt).toBe(stoppedAt)
    expect((await postReminderUnsubscribe(post(url, { token, intent: "resume" }), db, false)).status).toBe(303)
    expect(row.unsubscribedAt).toBeNull()
    expect(await updateMany.mock.results.at(-1)?.value).toEqual({ count: 1 })
    await postReminderUnsubscribe(post(url, { token, intent: "resume" }), db, false)
    expect(await updateMany.mock.results.at(-1)?.value).toEqual({ count: 0 })
    expect(await readReminderUnsubscribeState(db, token)).toMatchObject({ kind: "confirm" })
    expect(await automaticReminderSuppressed(db, row.organizationId, row.recipient, false)).toBe(false)
    await postReminderUnsubscribe(post(`${url}?token=${token}`, { "List-Unsubscribe": "One-Click", intent: "resume" }), db, true)
    expect(row.unsubscribedAt).not.toBeNull()
    const wrongToken = signReminderUnsubscribeToken({ ...row, organizationId: "other" }, secret)
    await postReminderUnsubscribe(post(url, { token: wrongToken, intent: "resume" }), db, false)
    expect(row.unsubscribedAt).not.toBeNull()
    expect((await postReminderUnsubscribe(post(url, { token, intent: "unknown" }), db, false)).status).toBe(400)
    expect(row.unsubscribedAt).not.toBeNull()
  })

  it("fails closed for unknown, tampered or cross-organization bindings", async () => {
    const { row, db, updateMany } = fixture()
    const wrongOrg = signReminderUnsubscribeToken({ ...row, organizationId: "org-two" }, secret)
    const wrongRecipient = signReminderUnsubscribeToken({ ...row, recipient: "other@example.test" }, secret)
    const unknown = signReminderUnsubscribeToken({ ...row, id: "39ee2ce9-bdf0-4c0b-9975-2c8a229787ce" }, secret)
    for (const token of ["", wrongOrg, wrongRecipient, unknown]) expect(await reminderUnsubscribeState(db, token, "POST", "da")).toEqual({ kind: "invalid", locale: "da-DK" })
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("accepts cookie-free RFC 8058 POSTs, rejects scanners and wrong bodies, and sets privacy headers", async () => {
    const { db, row } = fixture()
    const token = signReminderUnsubscribeToken(row, secret)
    const url = `https://app.example.test/api/reminders/unsubscribe?token=${token}`
    expect((await postReminderUnsubscribe(new Request(url), db, true)).status).toBe(405)
    const post = (body: string) => new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })
    for (const body of ["", "List-Unsubscribe=No", "List-Unsubscribe=One-Click&List-Unsubscribe=One-Click"]) expect((await postReminderUnsubscribe(post(body), db, true)).status).toBe(400)
    expect(row.unsubscribedAt).toBeNull()
    for (let i = 0; i < 2; i++) {
      const response = await postReminderUnsubscribe(post("List-Unsubscribe=One-Click"), db, true)
      expect(response.status).toBe(204)
      expect(response.headers.get("location")).toBeNull()
      expect(response.headers.get("cache-control")).toContain("no-store")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    }
    const form = new Request("https://app.example.test/reminders/unsubscribe", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) })
    expect((await postReminderUnsubscribe(form, db, false)).status).toBe(303)
  })

  it("accepts RFC 8058 multipart POSTs and rejects malformed, duplicate or file fields", async () => {
    const { db, row } = fixture()
    const token = signReminderUnsubscribeToken(row, secret)
    const url = `https://app.example.test/api/reminders/unsubscribe?token=${token}`
    const malformed = new Request(url, { method: "POST", headers: { "Content-Type": "multipart/form-data" }, body: "broken" })
    expect((await postReminderUnsubscribe(malformed, db, true)).status).toBe(400)
    for (const value of ["One-Click", new Blob(["One-Click"])]) {
      const invalid = new FormData()
      invalid.append("List-Unsubscribe", "One-Click")
      invalid.append("List-Unsubscribe", value)
      expect((await postReminderUnsubscribe(new Request(url, { method: "POST", body: invalid }), db, true)).status).toBe(400)
    }
    expect(row.unsubscribedAt).toBeNull()
    const form = new FormData()
    form.set("List-Unsubscribe", "One-Click")
    expect((await postReminderUnsubscribe(new Request(url, { method: "POST", body: form }), db, true)).status).toBe(204)
    expect(row.unsubscribedAt).not.toBeNull()
  })

  it("rejects unsupported, oversized and invalid POST requests without changing preferences", async () => {
    const { db, row, updateMany } = fixture()
    const url = "https://app.example.test/api/reminders/unsubscribe?token=bad"
    expect((await postReminderUnsubscribe(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), db, true)).status).toBe(415)
    expect((await postReminderUnsubscribe(new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a".repeat(2049) }), db, true)).status).toBe(413)
    expect((await postReminderUnsubscribe(new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }), db, true)).status).toBe(400)
    const invalidForm = await postReminderUnsubscribe(new Request("https://app.example.test/reminders/unsubscribe", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=bad" }), db, false)
    expect(invalidForm.status).toBe(303)
    expect(invalidForm.headers.get("location")).toBe("/reminders/unsubscribe")
    expect(row.unsubscribedAt).toBeNull()
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("suppresses only the same organization and mailbox, leaving manual reminders available", async () => {
    const { row, db, findUnique } = fixture()
    row.unsubscribedAt = new Date()
    expect(await automaticReminderSuppressed(db, row.organizationId, " BUYER@EXAMPLE.TEST ", false)).toBe(true)
    expect(await automaticReminderSuppressed(db, "org-two", row.recipient, false)).toBe(false)
    expect(await automaticReminderSuppressed(db, row.organizationId, "other@example.test", false)).toBe(false)
    findUnique.mockClear()
    expect(await automaticReminderSuppressed(db, row.organizationId, row.recipient, true)).toBe(false)
    expect(findUnique).not.toHaveBeenCalled()
  })
})

describe("quote and invoice unsubscribe footer", () => {
  it("keeps mail unchanged without an absolute origin and warns once without recipient data", async () => {
    const warn = vi.spyOn(appLogger, "warn")
    vi.stubEnv("YAIP_APP_ORIGIN", "")
    vi.stubEnv("BETTER_AUTH_URL", "")
    const { db } = fixture()
    const message = { from: "seller@example.test", to: binding.recipient, subject: "Invoice", html: "<body>Invoice</body>" }
    for (const origin of ["", "/relative"]) {
      vi.stubEnv("QUITS_APP_ORIGIN", origin)
      expect(await addReminderUnsubscribe({ db, organizationId: binding.organizationId, locale: binding.locale, message })).toBe(message)
    }
    expect(warn.mock.calls).toEqual([["reminders.unsubscribe_origin_missing"]])
  })

  it.each(["da-DK", "en-US"])("adds reminder-only %s copy, an opaque link and HTTPS one-click headers", async locale => {
    const { db } = fixture()
    const document = { number: "DOC-1", issueDate: "2026-10-01", dueDate: "2026-10-31", expiryDate: "2026-10-31", subtotal: 100, taxAmount: 0, total: 100, currency: "DKK", items: [] }
    const common = { org: { companyName: "Seller", locale }, contactName: "Buyer" }
    const contents = [buildInvoiceEmailContent({ ...common, invoice: document }), buildQuoteEmailContent({ ...common, quote: document })]
    for (const content of contents) {
      expect(content.html).not.toContain("automatic-reminder-preferences")
      const message = await addReminderUnsubscribe({ db, organizationId: "org-one", locale, message: composeMessage(binding.recipient, content) })
      expect(message.html).toContain(locale === "da-DK" ? "Afmeld automatiske påmindelser" : "Unsubscribe from automatic reminders")
      expect(message.html).toContain(locale === "da-DK" ? "Tilbud, fakturaer og påmindelser sendt af sælgeren kommer stadig frem." : "Quotes, invoices and reminders sent by the seller will still arrive.")
      const href = /href="([^"]*reminders\/unsubscribe[^"]*)"/.exec(message.html)?.[1]
      expect(href).toBeTruthy()
      expect(href).not.toContain(binding.recipient)
      expect(href).not.toContain(binding.organizationId)
      expect(message.headers).toMatchObject({ "List-Unsubscribe": expect.stringMatching(/^<https:\/\/app.example.test\/api\/reminders\/unsubscribe\?token=v1\./), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" })
    }
  })

  it("keeps self-hosted HTTP links usable without advertising unsupported one-click", async () => {
    vi.stubEnv("QUITS_APP_ORIGIN", "http://localhost:3000")
    const { db, row } = fixture()
    row.unsubscribedAt = new Date()
    const message = await addReminderUnsubscribe({ db, organizationId: row.organizationId, locale: row.locale, message: { from: "seller@example.test", to: row.recipient, subject: "Invoice", html: "<body></body>" } })
    expect(message.headers?.["List-Unsubscribe"]).toContain("<http://localhost:3000/reminders/unsubscribe?")
    expect(message.headers).not.toHaveProperty("List-Unsubscribe-Post")
    expect(row.unsubscribedAt).not.toBeNull()
  })
})
