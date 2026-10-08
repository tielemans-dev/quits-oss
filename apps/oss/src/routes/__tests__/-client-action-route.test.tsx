// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ClientActionState } from "../../lib/client-actions/public-session"

const session = vi.hoisted(() => ({
  token: "link-a",
  loaded: null as ClientActionState | null,
  getState: vi.fn(),
  requestCode: vi.fn(),
  submitCode: vi.fn(),
  perform: vi.fn(),
  navigate: vi.fn(),
}))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: object) => ({
    ...config,
    useLoaderData: () => session.loaded,
    useParams: () => ({ token: session.token }),
    useSearch: () => ({ item: "deliverable:d1" }),
    useNavigate: () => session.navigate,
  }),
}))
vi.mock("../../lib/client-actions/public-session", () => ({
  getClientActionState: session.getState,
  requestClientActionCode: session.requestCode,
  submitClientActionCode: session.submitCode,
  submitClientAction: session.perform,
}))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("../../components/documents/localized-document", () => ({
  LocalizedDocument: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("../../components/client-actions/client-action-hub", () => ({ ClientActionHub: () => null }))
// The real route and verification form run here. The delivery presenter exposes a decision button
// so a server expiry response can be exercised without constructing unrelated document DTOs.
vi.mock("../../components/client-actions/client-action-details", () => ({
  AgreementDetail: () => null,
  InvoiceDetail: () => null,
  DeliverableDetail: ({ verified, perform, error }: {
    verified: boolean
    perform: (request: object) => Promise<boolean>
    error: string | null
  }) => (
    <>
      <button disabled={!verified} onClick={() => void perform({ type: "deliverable.accept", deliverableId: "d1", deliveryRevision: 1, confirmed: true })}>Approve</button>
      {error && <p role="alert">{error}</p>}
    </>
  ),
}))

import { Route } from "../c.$token"
const Content = (Route as unknown as { component: ComponentType }).component
function ready(verified = false): ClientActionState {
  return {
    kind: "ready",
    page: { locale: "en-US", seller: { name: "Seller" }, verification: { required: true, verified, emailHint: "a@example.test" } },
    detail: { kind: "deliverable", recordId: "d1", locale: "en-US" },
  } as ClientActionState
}
async function verify() {
  fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.send" }))
  fireEvent.change(await screen.findByLabelText("clientActions.gate.codeLabel"), { target: { value: "123456" } })
  fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.verify" }))
  await waitFor(() => expect(screen.queryByRole("heading", { name: "clientActions.gate.title" })).toBeNull())
  expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false)
}

beforeEach(() => {
  vi.clearAllMocks()
  session.token = "link-a"
  session.loaded = ready()
  session.requestCode.mockResolvedValue({ status: "sent" })
  session.submitCode.mockResolvedValue({ status: "verified" })
  session.getState.mockResolvedValue(ready(true))
  session.perform.mockResolvedValue({ outcome: { status: "verification_required" }, state: ready() })
})
afterEach(cleanup)

describe("client action verification recovery", () => {
  it("restores the code form after the server refuses an expired session and allows verifying again", async () => {
    render(<Content />)
    await verify()
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "clientActions.refused.verification_required")
    expect(screen.getByRole("heading", { name: "clientActions.gate.title" })).toBeTruthy()
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true)
    await verify()
    expect(session.requestCode).toHaveBeenCalledTimes(2)
  })

  it("honors an unverified loader refresh after in-page verification", async () => {
    const view = render(<Content />)
    await verify()
    session.loaded = ready()
    view.rerender(<Content />)
    await waitFor(() => expect(screen.getByRole("heading", { name: "clientActions.gate.title" })).toBeTruthy())
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("does not carry verification or a partly entered code to a different token", async () => {
    const view = render(<Content />)
    await verify()
    session.token = "link-b"
    session.loaded = ready()
    view.rerender(<Content />)
    await waitFor(() => expect(screen.getByRole("heading", { name: "clientActions.gate.title" })).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.send" }))
    fireEvent.change(await screen.findByLabelText("clientActions.gate.codeLabel"), { target: { value: "123" } })
    session.token = "link-c"
    session.loaded = ready()
    view.rerender(<Content />)
    await waitFor(() => expect(screen.queryByLabelText("clientActions.gate.codeLabel")).toBeNull())
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
