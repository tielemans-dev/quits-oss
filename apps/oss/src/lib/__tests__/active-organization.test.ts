// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  calls: [] as string[],
  setActive: vi.fn(),
  loadPage: vi.fn(),
}))

vi.mock("../auth-client", () => ({
  authClient: { organization: { setActive: state.setActive } },
  useSession: vi.fn(),
}))
vi.mock("../page-navigation", () => ({ loadPage: state.loadPage, reloadPage: vi.fn() }))

import { invalidateAppLayoutSession, reuseAppLayoutSession } from "../app-layout-session"
import {
  getRequestOrganizationId,
  initializeRequestOrganizationId,
  isRequestOrganizationInitialized,
  resetRequestOrganizationForTesting,
  switchActiveOrganization,
} from "../active-organization"

afterEach(() => {
  invalidateAppLayoutSession()
  resetRequestOrganizationForTesting()
  state.calls = []
  state.setActive.mockReset()
  state.loadPage.mockReset()
})

function recordCalls() {
  state.setActive.mockImplementation(async ({ organizationId }: { organizationId: string }) => {
    state.calls.push(`setActive:${organizationId}`)
    return { data: {}, error: null }
  })
  state.loadPage.mockImplementation((path: string) => state.calls.push(`loadPage:${path}`))
}

describe("request organization store", () => {
  it("is set once per page load", () => {
    expect(isRequestOrganizationInitialized()).toBe(false)
    initializeRequestOrganizationId("org_a")
    initializeRequestOrganizationId("org_b")
    expect(getRequestOrganizationId()).toBe("org_a")
  })

  it("remembers a page load without an organization", () => {
    initializeRequestOrganizationId(null)
    initializeRequestOrganizationId("org_b")
    expect(isRequestOrganizationInitialized()).toBe(true)
    expect(getRequestOrganizationId()).toBeNull()
  })
})

describe("switching organization", () => {
  it("switches the session, then loads a new page, without changing this page's organization", async () => {
    recordCalls()
    initializeRequestOrganizationId("org_a")

    await switchActiveOrganization("org_b")

    expect(state.calls).toEqual(["setActive:org_b", "loadPage:/"])
    expect(getRequestOrganizationId()).toBe("org_a")
  })

  it("drops the layout's cached session, so the new page does not see the previous organization", async () => {
    recordCalls()
    const load = vi.fn(async () => ({ session: { user: "u_1" } }))
    await reuseAppLayoutSession(load)

    await switchActiveOrganization("org_b")
    await reuseAppLayoutSession(load)

    expect(load).toHaveBeenCalledTimes(2)
  })

  it("loads the requested destination", async () => {
    recordCalls()
    await switchActiveOrganization("org_b", { destination: "/onboarding" })
    expect(state.calls).toEqual(["setActive:org_b", "loadPage:/onboarding"])
    expect(isRequestOrganizationInitialized()).toBe(false)
  })

  it("loads nothing when the switch failed", async () => {
    state.setActive.mockResolvedValue({ data: null, error: { message: "nope" } })
    const result = await switchActiveOrganization("org_b")
    expect(result?.error).toEqual({ message: "nope" })
    expect(state.loadPage).not.toHaveBeenCalled()
  })

  it("loads nothing when the flow was abandoned meanwhile", async () => {
    recordCalls()
    let cancelled = false
    const pending = switchActiveOrganization("org_b", { isCancelled: () => cancelled })
    cancelled = true
    await pending
    expect(state.calls).toEqual(["setActive:org_b"])
  })
})
