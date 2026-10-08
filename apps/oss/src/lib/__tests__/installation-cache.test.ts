// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import type { InstallationStatus } from "../installation-state"
import {
  forgetInstallationStatus,
  rememberInstallationStatus,
  reuseInstallationStatus,
} from "../installation-cache"

function status(isSetupComplete: boolean): InstallationStatus {
  return { isSetupComplete, distribution: "selfhost", setupVersion: 1, billingEnabled: false }
}

afterEach(() => {
  forgetInstallationStatus()
  vi.unstubAllEnvs()
})

describe("installation status reuse", () => {
  it("asks the server once after setup is complete, then never again", async () => {
    const load = vi.fn(async () => status(true))
    await reuseInstallationStatus(load)
    await reuseInstallationStatus(load)
    await reuseInstallationStatus(load)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("never keeps an incomplete setup, so finishing the wizard cannot loop back to /setup", async () => {
    const load = vi.fn().mockResolvedValueOnce(status(false)).mockResolvedValueOnce(status(false))
    await reuseInstallationStatus(load)
    await reuseInstallationStatus(load)
    expect(load).toHaveBeenCalledTimes(2)

    // Setup finishes: the very next navigation sees it.
    load.mockResolvedValueOnce(status(true))
    expect((await reuseInstallationStatus(load)).isSetupComplete).toBe(true)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it("is seeded from the answer the server rendered into the page", async () => {
    rememberInstallationStatus(status(true))
    const load = vi.fn(async () => status(true))
    await reuseInstallationStatus(load)
    expect(load).not.toHaveBeenCalled()
  })

  it("ignores a rendered incomplete or missing answer", async () => {
    rememberInstallationStatus(status(false))
    rememberInstallationStatus(undefined)
    const load = vi.fn(async () => status(false))
    await reuseInstallationStatus(load)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("is dropped when the setup wizard completes", async () => {
    rememberInstallationStatus(status(true))
    forgetInstallationStatus()
    const load = vi.fn(async () => status(true))
    await reuseInstallationStatus(load)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("keeps nothing in the server build, where the module is shared between requests", async () => {
    vi.stubEnv("SSR", true)
    const load = vi.fn(async () => status(true))
    await reuseInstallationStatus(load)
    rememberInstallationStatus(status(true))
    await reuseInstallationStatus(load)
    expect(load).toHaveBeenCalledTimes(2)

    vi.stubEnv("SSR", false)
    await reuseInstallationStatus(load)
    expect(load).toHaveBeenCalledTimes(3)
  })
})
