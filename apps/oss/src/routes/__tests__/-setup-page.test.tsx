// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

const { navigate, getStatusQuery } = vi.hoisted(() => ({
  navigate: vi.fn(),
  getStatusQuery: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  redirect: vi.fn(),
  useNavigate: () => navigate,
}))

vi.mock("../../lib/i18n/react", () => ({
  useI18n: () => ({
    t: (key: string) =>
      (
        {
          "setup.loadingStatus": "Loading setup status...",
          "setup.error.loadStatus": "Could not load setup status. Refresh and try again.",
          "setup.complete.loginPrompt": "Setup complete. Please sign in to continue.",
        } as const
      )[key] ?? key,
  }),
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    setup: {
      getStatus: {
        query: getStatusQuery,
      },
      initialize: {
        mutate: vi.fn(),
      },
      complete: {
        mutate: vi.fn(),
      },
    },
  },
}))

vi.mock("../../components/setup/setup-wizard", () => ({
  SetupWizard: () => <div>Setup wizard</div>,
}))

import { Route } from "../setup"
import { asMockedRoute } from "../../test-utils/mocked-route"

const route = asMockedRoute(Route)
const RoutePage = route.component

afterEach(() => {
  cleanup()
  navigate.mockReset()
  getStatusQuery.mockReset()
})

describe("SetupPage", () => {
  it("shows a load error when the setup status response is missing", async () => {
    getStatusQuery.mockResolvedValue(undefined)

    render(<RoutePage />)

    await waitFor(() => {
      expect(
        screen.getByText("Could not load setup status. Refresh and try again.")
      ).toBeTruthy()
    })

    expect(navigate).not.toHaveBeenCalled()
  })
})
