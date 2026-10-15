import { describe, expect, it, vi } from "vitest"
import { SESSION_VISIBLE_ATTEMPTS, listOrganizationsAfterSignIn } from "../post-login"

const unauthorized = { error: { status: 401 } }
const sleep = () => vi.fn(async () => {})

describe("listOrganizationsAfterSignIn", () => {
  it("returns the organizations on the first try without waiting", async () => {
    const wait = sleep()
    const list = vi.fn(async () => ({ data: [{ id: "org_1" }] }))
    await expect(listOrganizationsAfterSignIn(list, wait)).resolves.toEqual({ kind: "listed", organizations: [{ id: "org_1" }] })
    expect(list).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })

  it("waits out a session the server cannot see yet instead of reporting no organizations", async () => {
    const wait = sleep()
    const list = vi.fn()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce({ data: [{ id: "org_1" }] })
    await expect(listOrganizationsAfterSignIn(list, wait)).resolves.toEqual({ kind: "listed", organizations: [{ id: "org_1" }] })
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it("reports no session when it never becomes visible", async () => {
    const wait = sleep()
    const list = vi.fn(async () => unauthorized)
    await expect(listOrganizationsAfterSignIn(list, wait)).resolves.toEqual({ kind: "no-session" })
    expect(list).toHaveBeenCalledTimes(SESSION_VISIBLE_ATTEMPTS)
  })

  it("does not retry other failures", async () => {
    const wait = sleep()
    const list = vi.fn(async () => ({ error: { status: 500 } }))
    await expect(listOrganizationsAfterSignIn(list, wait)).resolves.toEqual({ kind: "unavailable" })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it("treats a successful answer without data as an empty list", async () => {
    await expect(listOrganizationsAfterSignIn(async () => ({ data: null }), sleep())).resolves.toEqual({ kind: "listed", organizations: [] })
  })
})
