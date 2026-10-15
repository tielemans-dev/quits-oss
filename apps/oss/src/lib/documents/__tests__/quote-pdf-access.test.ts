import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ session: vi.fn(), actor: vi.fn(), find: vi.fn(), render: vi.fn() }))
vi.mock("../../auth", () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock("../../db", () => ({ prisma: { quote: { findFirst: mocks.find } } }))
vi.mock("../../../domain/user-actor", () => ({ resolveUserActor: mocks.actor }))
vi.mock("../../quote-pdf", () => ({ renderQuotePdf: mocks.render }))
vi.mock("../../../application/issuance", () => ({ runArtifactRead: vi.fn() }))
vi.mock("../../../domain/documents/render-input", () => ({ prospectiveRenderInput: vi.fn(), hashBytes: vi.fn() }))
vi.mock("../../../domain/commands/reminders", () => ({ schedulerActor: vi.fn() }))
import { privateDocumentPdf } from "../pdf-access"

const request = new Request("https://example.test/api/documents/quote/q1/pdf")
beforeEach(() => {
  vi.resetAllMocks()
  mocks.session.mockResolvedValue({ user: { id: "u1" }, session: { activeOrganizationId: "org1" } })
  mocks.actor.mockResolvedValue({ kind: "user", organizationId: "org1", roles: ["admin"] })
  mocks.render.mockResolvedValue(new TextEncoder().encode("%PDF-test"))
})

describe("private quote PDF downloads", () => {
  it("requires a session and active organization before reading the quote", async () => {
    for (const session of [null, { user: { id: "u1" }, session: {} }]) {
      mocks.session.mockResolvedValue(session)
      expect((await privateDocumentPdf(request, "quote", "q1")).status).toBe(401)
    }
    expect(mocks.find).not.toHaveBeenCalled()
  })
  it("requires quote:read permission", async () => {
    mocks.actor.mockResolvedValue({ kind: "user", roles: [] })
    expect((await privateDocumentPdf(request, "quote", "q1")).status).toBe(403)
    expect(mocks.find).not.toHaveBeenCalled()
  })
  it("scopes lookup to the active organization and hides missing quotes", async () => {
    mocks.find.mockResolvedValue(null)
    expect((await privateDocumentPdf(request, "quote", "q1")).status).toBe(404)
    expect(mocks.find.mock.calls[0][0].where).toEqual({ id: "q1", organizationId: "org1" })
    expect(mocks.render).not.toHaveBeenCalled()
  })
  it.each([null, "T-0021", 'T/21"'])("downloads quote %s with safe headers", async number => {
    const quote = { id: "q1", number }
    mocks.find.mockResolvedValue(quote)
    const response = await privateDocumentPdf(request, "quote", "q1")
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("application/pdf")
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="${number?.replace(/[^a-zA-Z0-9_-]/g, "_") ?? "draft"}.pdf"`)
    expect(await response.text()).toBe("%PDF-test")
    expect(mocks.render).toHaveBeenCalledWith(quote)
  })
})
