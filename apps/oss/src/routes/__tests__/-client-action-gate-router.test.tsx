// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { StrictMode, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ClientActionState, CodeCheckResult, SubmitClientActionResult } from "../../lib/client-actions/public-session"

const session = vi.hoisted(() => ({
  getState: vi.fn(), requestCode: vi.fn(), submitCode: vi.fn(), perform: vi.fn(),
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
// Only the document DTO presenter is replaced. Router, route, gate, form and buttons are real.
vi.mock("../../components/client-actions/client-action-details", () => ({
  AgreementDetail: () => null,
  DeliverableDetail: () => null,
  InvoiceDetail: ({ paying, onPay, error }: { paying: boolean; onPay: () => void; error: string | null }) => (
    <>
      <button disabled={paying} onClick={onPay}>Pay</button>
      {error && <p role="alert">{error}</p>}
    </>
  ),
}))

import { Route } from "../c.$token"

function ready(verified = false): ClientActionState {
  // This invoice can be paid without verification; a separate approval grant needs the gate.
  return {
    kind: "ready",
    page: { locale: "en-US", seller: { name: "Seller" }, verification: { required: true, verified, emailHint: "a@example.test" } },
    detail: { kind: "invoice", recordId: "i1", locale: "en-US" },
  } as ClientActionState
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function openInvoice() {
  const root = createRootRoute({ component: Outlet })
  // File-route id/path are normally assigned by the generated route tree.
  const options = { id: "/c/$token", path: "/c/$token", getParentRoute: () => root }
  Route.update(options as Parameters<typeof Route.update>[0])
  const router = createRouter({
    routeTree: root.addChildren([Route]),
    history: createMemoryHistory({ initialEntries: ["/c/link-a?item=invoice%3Ai1"] }),
    defaultStaleTime: Infinity,
    isServer: false,
  })
  await router.load()
  render(<StrictMode><RouterProvider router={router} /></StrictMode>)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.send" })))
  fireEvent.change(screen.getByLabelText("clientActions.gate.codeLabel"), { target: { value: "123456" } })
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "clientActions.gate.verify" })))
  expect(session.submitCode).toHaveBeenCalledTimes(1)
}
const verifyButton = () => screen.getByRole("button", { name: "clientActions.gate.verify" }) as HTMLButtonElement
const payButton = () => screen.getByRole("button", { name: "Pay" }) as HTMLButtonElement
const settlements = ["verified", "inactive", "wrong", "expired", "locked", "error"] as const
type Settlement = (typeof settlements)[number]
async function settle(code: ReturnType<typeof deferred<CodeCheckResult>>, outcome: Settlement) {
  await act(async () => {
    if (outcome === "error") code.reject(new Error("code request failed"))
    else code.resolve({ status: outcome })
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  session.getState.mockResolvedValue(ready())
  session.requestCode.mockResolvedValue({ status: "sent" })
})
afterEach(cleanup)

describe("verification feedback with the real router and gate", () => {
  it.each(settlements)("discards obsolete code %s while preserving the newer payment and a later verification", async (outcome) => {
    const code = deferred<CodeCheckResult>(), payment = deferred<SubmitClientActionResult>()
    session.submitCode.mockReturnValueOnce(code.promise)
    session.perform.mockReturnValueOnce(payment.promise)
    await openInvoice()
    expect(verifyButton().disabled).toBe(true)
    await act(async () => fireEvent.click(payButton()))
    expect(session.perform).toHaveBeenCalledTimes(1)
    expect(payButton().disabled).toBe(true)

    await settle(code, outcome)
    expect(session.getState).toHaveBeenCalledTimes(1) // Initial loader only; no obsolete refresh.
    expect(screen.getByRole("status").textContent).toBe("")
    expect(payButton().disabled).toBe(true)
    expect(verifyButton().disabled).toBe(false)
    expect(screen.queryByRole("alert")).toBeNull()

    // Payment started before any verified cookie arrived, so its state is still unverified.
    await act(async () => payment.resolve({ outcome: { status: "unavailable" }, state: ready() }))
    expect(screen.getByRole("alert").textContent).toBe("clientActions.refused.unavailable")
    expect(screen.getByRole("status").textContent).toBe("")
    expect(payButton().disabled).toBe(false)
    expect(verifyButton().disabled).toBe(false)

    session.submitCode.mockResolvedValueOnce({ status: "verified" })
    session.getState.mockResolvedValueOnce(ready(true))
    await act(async () => fireEvent.click(verifyButton()))
    expect(session.getState).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("heading", { name: "clientActions.gate.title" })).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it.each(settlements)("preserves current code %s feedback and retry", async (outcome) => {
    const code = deferred<CodeCheckResult>()
    session.submitCode.mockReturnValueOnce(code.promise)
    await openInvoice()
    expect(verifyButton().disabled).toBe(true)
    const refreshed = deferred<ClientActionState>()
    session.getState.mockReturnValueOnce(refreshed.promise)
    await settle(code, outcome)
    const expected = outcome === "inactive" ? "clientActions.refused.inactive"
      : outcome === "error" ? "clientActions.refused.failed" : `clientActions.gate.${outcome}`
    expect(screen.getByRole("status").textContent).toBe(expected)
    expect(verifyButton().disabled).toBe(false)
    expect(payButton().disabled).toBe(false)
    expect(session.getState).toHaveBeenCalledTimes(outcome === "verified" ? 2 : 1)
    if (outcome !== "verified") {
      session.submitCode.mockResolvedValueOnce({ status: "verified" })
      await act(async () => fireEvent.click(verifyButton()))
      expect(session.getState).toHaveBeenCalledTimes(2)
    }
    await act(async () => refreshed.resolve(ready(true)))
    expect(screen.queryByRole("heading", { name: "clientActions.gate.title" })).toBeNull()
    expect(session.perform).not.toHaveBeenCalled()
  })
})
