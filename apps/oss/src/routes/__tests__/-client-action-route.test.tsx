// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ClientActionState } from "../../lib/client-actions/public-session"

const session = vi.hoisted(() => ({
  token: "link-a",
  item: "deliverable:d1",
  loaded: null as ClientActionState | null,
  getState: vi.fn(),
  requestCode: vi.fn(),
  submitCode: vi.fn(),
  perform: vi.fn(),
  navigate: vi.fn(),
  actionResults: [] as boolean[],
}))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: object) => ({
    ...config,
    useLoaderData: () => session.loaded,
    useParams: () => ({ token: session.token }),
    useSearch: () => ({ item: session.item }),
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
  InvoiceDetail: ({ detail, paying, onPay, error }: { detail: { recordId: string }; paying: boolean; onPay: () => void; error: string | null }) => (
    <><p data-testid="record">{detail.recordId}</p><button onClick={onPay}>Pay</button><p data-testid="paying">{String(paying)}</p>{error && <p role="alert">{error}</p>}</>
  ),
  DeliverableDetail: ({ detail, verified, perform, error }: {
    detail: { recordId: string }
    verified: boolean
    perform: (request: object) => Promise<boolean>
    error: string | null
  }) => (
    <>
      <p data-testid="record">{detail.recordId}</p>
      <button disabled={!verified} onClick={async () => { session.actionResults.push(await perform({ type: "deliverable.accept", deliverableId: detail.recordId, deliveryRevision: 1, confirmed: true })) }}>Approve</button>
      {error && <p role="alert">{error}</p>}
    </>
  ),
}))

import { Route } from "../c.$token"
const Content = (Route as unknown as { component: ComponentType }).component
function ready(verified = false, recordId = "d1", kind = "deliverable"): ClientActionState {
  return {
    kind: "ready",
    page: { locale: "en-US", seller: { name: "Seller" }, verification: { required: true, verified, emailHint: "a@example.test" } },
    detail: { kind, recordId, locale: "en-US" },
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
  session.actionResults.length = 0
  session.token = "link-a"
  session.item = "deliverable:d1"
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function startVerification() {
  fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.send" }))
  fireEvent.change(await screen.findByLabelText("clientActions.gate.codeLabel"), { target: { value: "123456" } })
  fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.verify" }))
  await waitFor(() => expect(session.getState).toHaveBeenCalled())
}
const accepted = () => ({ outcome: { status: "ok", checkoutUrl: null }, state: ready(true) })

describe("client action response ownership", () => {
  it.each(["unverified", "revoked", "record", "token"])("discards verification refresh after a newer %s context", async (change) => {
    const response = deferred<ClientActionState>()
    session.getState.mockReturnValue(response.promise)
    const view = render(<Content />)
    await startVerification()
    if (change === "revoked") session.loaded = { kind: "inactive", reason: "revoked", seller: { name: "Seller" }, locale: "en-US" } as ClientActionState
    else {
      session.loaded = ready(change === "record", change === "record" || change === "token" ? "d2" : "d1")
      if (change === "record" || change === "token") session.item = "deliverable:d2"
      if (change === "token") session.token = "link-b"
    }
    view.rerender(<Content />)
    await act(async () => response.resolve(ready(true)))
    if (change === "revoked") {
      expect(screen.getByRole("heading").textContent).toBe("clientActions.inactive.revoked.title")
      expect(screen.queryByTestId("record")).toBeNull()
    } else {
      expect(screen.getByTestId("record").textContent).toBe(change === "unverified" ? "d1" : "d2")
      expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(change !== "record")
      expect(screen.queryByRole("heading", { name: "clientActions.gate.title" }) !== null).toBe(change !== "record")
    }
  })

  it.each(["loader", "revoked", "record", "token", "unmount"].flatMap((change) => ["success", "error"].map((result) => ({ change, result }))))("discards action $result after $change change", async ({ change, result }) => {
    session.loaded = ready(true)
    const response = deferred<ReturnType<typeof accepted>>()
    session.perform.mockReturnValue(response.promise)
    const view = render(<Content />)
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    if (change === "unmount") view.unmount()
    else {
      session.loaded = change === "revoked"
        ? { kind: "inactive", reason: "revoked", seller: { name: "Seller" }, locale: "en-US" } as ClientActionState
        : ready(false, change === "record" ? "d2" : "d1")
      if (change === "record") session.item = "deliverable:d2"
      if (change === "token") session.token = "link-b"
      view.rerender(<Content />)
    }
    await act(async () => { if (result === "success") response.resolve(accepted()); else response.reject(new Error("old failure")) })
    if (change === "revoked") expect(screen.getByRole("heading").textContent).toBe("clientActions.inactive.revoked.title")
    else if (change !== "unmount") {
      expect(screen.getByTestId("record").textContent).toBe(change === "record" ? "d2" : "d1")
      expect(screen.getByRole("heading", { name: "clientActions.gate.title" })).toBeTruthy()
    }
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText("clientActions.done.deliverable.accept")).toBeNull()
  })

  it.each(["success", "error"])("keeps the newer payment pending after superseded payment %s", async (result) => {
    session.loaded = ready(true, "i1", "invoice")
    session.item = "invoice:i1"
    const old = deferred<object>(), current = deferred<object>()
    session.perform.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    render(<Content />)
    fireEvent.click(screen.getByRole("button", { name: "Pay" }))
    fireEvent.click(screen.getByRole("button", { name: "Pay" }))
    const assign = vi.fn()
    const originalWindow = window
    vi.stubGlobal("window", new Proxy(originalWindow, { get: (target, key) => key === "location" ? { assign } : Reflect.get(target, key) }))
    try {
      await act(async () => {
        if (result === "success") old.resolve({ outcome: { status: "ok", checkoutUrl: "https://checkout.example.test/old" }, state: ready(true, "i1", "invoice") })
        else old.reject(new Error("obsolete payment"))
      })
      expect(screen.queryByRole("alert")).toBeNull()
      expect(assign).not.toHaveBeenCalled()
      expect(screen.getByTestId("paying").textContent).toBe("true")
      await act(async () => current.resolve({ outcome: { status: "ok", checkoutUrl: "https://checkout.example.test/current" }, state: ready(true, "i1", "invoice") }))
      expect(assign).toHaveBeenCalledExactlyOnceWith("https://checkout.example.test/current")
      expect(screen.getByTestId("paying").textContent).toBe("false")
    } finally { vi.unstubAllGlobals() }
  })

  it.each(["loader", "record", "token", "unmount"])("discards a checkout response after %s change", async (change) => {
    session.loaded = ready(true, "i1", "invoice")
    session.item = "invoice:i1"
    const response = deferred<object>()
    session.perform.mockReturnValue(response.promise)
    const view = render(<Content />)
    fireEvent.click(screen.getByRole("button", { name: "Pay" }))
    if (change === "unmount") view.unmount()
    else {
      session.loaded = ready(true, change === "loader" ? "i1" : "i2", "invoice")
      if (change === "record") session.item = "invoice:i2"
      if (change === "token") session.token = "link-b"
      view.rerender(<Content />)
    }
    const assign = vi.fn()
    vi.stubGlobal("window", new Proxy(window, { get: (target, key) => key === "location" ? { assign } : Reflect.get(target, key) }))
    try {
      await act(async () => response.resolve({ outcome: { status: "ok", checkoutUrl: "https://checkout.example.test/old" }, state: ready(true, "i1", "invoice") }))
      expect(assign).not.toHaveBeenCalled()
      if (change !== "unmount") expect(screen.getByTestId("paying").textContent).toBe("false")
    } finally { vi.unstubAllGlobals() }
  })

  it("discards superseded errors and preserves current action success", async () => {
    session.loaded = ready(true)
    const old = deferred<object>(), current = deferred<object>()
    session.perform.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    render(<Content />)
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    await act(async () => old.reject(new Error("obsolete")))
    expect(screen.queryByRole("alert")).toBeNull()
    await act(async () => current.resolve(accepted()))
    expect(screen.getByRole("status").textContent).toBe("clientActions.done.deliverable.accept")
    expect(session.actionResults).toEqual([false, true])
  })

  it("discards verification errors and delayed code callbacks after unmount", async () => {
    const response = deferred<ClientActionState>()
    session.getState.mockReturnValue(response.promise)
    const view = render(<Content />)
    await startVerification()
    session.loaded = ready(false, "d2")
    session.item = "deliverable:d2"
    view.rerender(<Content />)
    await act(async () => response.reject(new Error("obsolete verification")))
    expect(screen.queryByRole("alert")).toBeNull()
    const code = deferred<object>()
    session.submitCode.mockReturnValue(code.promise)
    fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.send" }))
    fireEvent.change(await screen.findByLabelText("clientActions.gate.codeLabel"), { target: { value: "123456" } })
    fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.verify" }))
    view.unmount()
    await act(async () => code.resolve({ status: "verified" }))
    expect(session.getState).toHaveBeenCalledTimes(1)
  })
})

describe("verification request supersession", () => {
  it("discards a verification refresh superseded by another verification", async () => {
    const old = deferred<ClientActionState>(), current = deferred<ClientActionState>()
    session.getState.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    render(<Content />)
    await startVerification()
    // The first cookie refresh is still pending. A later successful verification owns the UI.
    fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.verify" }))
    await waitFor(() => expect(session.getState).toHaveBeenCalledTimes(2))
    await act(async () => current.resolve(ready(false, "d2")))
    await act(async () => old.resolve(ready(true)))
    expect(screen.getByTestId("record").textContent).toBe("d2")
    expect(screen.getByRole("heading", { name: "clientActions.gate.title" })).toBeTruthy()
  })

  it("does not start an obsolete cookie refresh when payment supersedes code submission", async () => {
    session.loaded = ready(false, "i1", "invoice")
    session.item = "invoice:i1"
    const code = deferred<object>(), payment = deferred<object>()
    session.submitCode.mockReturnValue(code.promise)
    session.perform.mockReturnValue(payment.promise)
    render(<Content />)
    fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.send" }))
    fireEvent.change(await screen.findByLabelText("clientActions.gate.codeLabel"), { target: { value: "123456" } })
    fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.verify" }))
    fireEvent.click(screen.getByRole("button", { name: "Pay" }))
    await act(async () => code.resolve({ status: "verified" }))
    expect(session.getState).not.toHaveBeenCalled()
    expect(screen.getByTestId("paying").textContent).toBe("true")
    await act(async () => payment.resolve({ outcome: { status: "ok", checkoutUrl: null }, state: ready(true, "i1", "invoice") }))
    expect(screen.getByTestId("paying").textContent).toBe("false")
  })

  it("keeps the current action failure and allows a later successful request", async () => {
    session.loaded = ready(true)
    session.perform.mockRejectedValueOnce(new Error("current failure")).mockResolvedValueOnce(accepted())
    render(<Content />)
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    expect((await screen.findByRole("alert")).textContent).toBe("clientActions.refused.failed")
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    expect((await screen.findByRole("status")).textContent).toBe("clientActions.done.deliverable.accept")
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

it("keeps a payment on a new record pending when the previous record's payment settles", async () => {
  session.loaded = ready(true, "i1", "invoice")
  session.item = "invoice:i1"
  const old = deferred<object>(), current = deferred<object>()
  session.perform.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const view = render(<Content />)
  fireEvent.click(screen.getByRole("button", { name: "Pay" }))
  session.loaded = ready(true, "i2", "invoice")
  session.item = "invoice:i2"
  view.rerender(<Content />)
  fireEvent.click(screen.getByRole("button", { name: "Pay" }))
  await act(async () => old.reject(new Error("previous invoice")))
  expect(screen.getByTestId("record").textContent).toBe("i2")
  expect(screen.getByTestId("paying").textContent).toBe("true")
  expect(screen.queryByRole("alert")).toBeNull()
  await act(async () => current.resolve({ outcome: { status: "unavailable" }, state: ready(true, "i2", "invoice") }))
  expect(screen.getByTestId("paying").textContent).toBe("false")
  expect(screen.getByRole("alert").textContent).toBe("clientActions.refused.unavailable")
})
