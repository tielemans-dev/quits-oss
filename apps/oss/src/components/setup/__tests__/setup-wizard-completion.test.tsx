// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ complete: vi.fn(), initialize: vi.fn() }))

vi.mock("../../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("../../../trpc/client", () => ({
  trpc: { setup: { initialize: { mutate: state.initialize }, complete: { mutate: state.complete } } },
}))
vi.mock("../steps/step-email-finish", () => ({ EmailFinishStep: () => null }))

import { forgetInstallationStatus, rememberInstallationStatus, reuseInstallationStatus } from "../../../lib/installation-cache"
import { SetupWizard } from "../setup-wizard"

afterEach(() => {
  cleanup()
  forgetInstallationStatus()
  state.complete.mockReset()
})

describe("setup wizard completion", () => {
  it("drops the kept installation answer before handing over, so nothing stale outlives setup", async () => {
    state.complete.mockResolvedValue(undefined)
    rememberInstallationStatus({ isSetupComplete: true, distribution: "selfhost", setupVersion: 1, billingEnabled: false })
    const onCompleted = vi.fn()

    render(
      <SetupWizard
        initialStatus={{
          isSetupComplete: false,
          distribution: "selfhost",
          setupVersion: 1,
          hasSeedData: false,
          stage: "initialized",
          organizationId: "org_1",
          adminUserId: "u_1",
        }}
        onCompleted={onCompleted}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByText("setup.action.finish"))
    })

    expect(state.complete).toHaveBeenCalledTimes(1)
    expect(onCompleted).toHaveBeenCalledTimes(1)

    // The navigation that follows must reach the server rather than hit the kept answer.
    const load = vi.fn(async () => ({ isSetupComplete: true, distribution: "selfhost", setupVersion: 1, billingEnabled: false }))
    await reuseInstallationStatus(load)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
