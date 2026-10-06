// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const api = vi.hoisted(() => ({ getPolicy: vi.fn(), capabilities: vi.fn(), updatePolicy: vi.fn() }))

vi.mock("../../../trpc/client", () => ({
  trpc: {
    reminders: {
      getPolicy: { query: api.getPolicy },
      capabilities: { query: api.capabilities },
      updatePolicy: { mutate: api.updatePolicy },
    },
  },
}))

const auth = vi.hoisted(() => ({
  session: { data: { session: { activeOrganizationId: "org_a" } }, isPending: false },
}))

vi.mock("../../../lib/auth-client", () => ({
  useSession: () => auth.session,
}))

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({ t: translate }),
}))

import { ReminderPolicyCard } from "../reminder-policy-card"

// A stable translate function, as the real i18n context provides.
function translate(key: string) {
  return key
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  auth.session = { data: { session: { activeOrganizationId: "org_a" } }, isPending: false }
})

describe("ReminderPolicyCard", () => {
  it("lets an admin edit and save the policy", async () => {
    api.getPolicy.mockResolvedValue({ enabled: true, offsetsDays: [-3, 7] })
    api.capabilities.mockResolvedValue({ canSendNow: true, canPause: true, canResume: true, canUpdatePolicy: true })
    render(<ReminderPolicyCard />)

    expect(await screen.findByRole("button", { name: "reminders.policy.save" })).toBeTruthy()
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false)
    expect(screen.queryByText("reminders.policy.readOnly")).toBeNull()
  })

  it.each([
    ["member", { canSendNow: true, canPause: true, canResume: true, canUpdatePolicy: false }],
    ["accountant", { canSendNow: false, canPause: false, canResume: false, canUpdatePolicy: false }],
  ])("shows the policy read-only to a %s", async (_role, capabilities) => {
    api.getPolicy.mockResolvedValue({ enabled: true, offsetsDays: [-3, 7] })
    api.capabilities.mockResolvedValue(capabilities)
    render(<ReminderPolicyCard />)

    expect(await screen.findByText("reminders.policy.readOnly")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "reminders.policy.save" })).toBeNull()
    expect(screen.queryByRole("button", { name: "reminders.policy.offsets.add" })).toBeNull()
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true)
    for (const input of screen.getAllByRole("spinbutton") as HTMLInputElement[]) {
      expect(input.disabled).toBe(true)
    }
  })

  it("reloads the policy and drops edit rights when the user switches organization", async () => {
    api.getPolicy.mockResolvedValueOnce({ enabled: true, offsetsDays: [-3, 7] })
    api.capabilities.mockResolvedValueOnce({ canSendNow: true, canPause: true, canUpdatePolicy: true })
    const { rerender } = render(<ReminderPolicyCard />)
    expect(await screen.findByRole("button", { name: "reminders.policy.save" })).toBeTruthy()

    api.getPolicy.mockReturnValueOnce(new Promise(() => undefined))
    api.capabilities.mockResolvedValueOnce({ canSendNow: false, canPause: false, canUpdatePolicy: false })
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<ReminderPolicyCard />)

    expect(screen.queryByRole("button", { name: "reminders.policy.save" })).toBeNull()
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true)
    await waitFor(() => expect(api.getPolicy).toHaveBeenCalledTimes(2))
    expect(api.capabilities).toHaveBeenCalledTimes(2)
  })

  it("grants edit rights after switching to an organization where the user is an admin", async () => {
    api.getPolicy.mockResolvedValue({ enabled: true, offsetsDays: [-3, 7] })
    api.capabilities.mockResolvedValueOnce({ canSendNow: false, canPause: false, canUpdatePolicy: false })
    const { rerender } = render(<ReminderPolicyCard />)
    expect(await screen.findByText("reminders.policy.readOnly")).toBeTruthy()

    api.capabilities.mockResolvedValueOnce({ canSendNow: true, canPause: true, canUpdatePolicy: true })
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<ReminderPolicyCard />)

    expect(await screen.findByRole("button", { name: "reminders.policy.save" })).toBeTruthy()
  })

  it("ignores a save response that arrives after the user switched organization", async () => {
    const admin = { canSendNow: true, canPause: true, canResume: true, canUpdatePolicy: true }
    api.getPolicy.mockResolvedValueOnce({ enabled: true, offsetsDays: [-3, 7] })
    api.capabilities.mockResolvedValue(admin)
    let resolveSave: (policy: { enabled: boolean; offsetsDays: number[] }) => void = () => undefined
    api.updatePolicy.mockReturnValueOnce(new Promise((resolve) => (resolveSave = resolve)))
    const { rerender } = render(<ReminderPolicyCard />)
    fireEvent.click(await screen.findByRole("button", { name: "reminders.policy.save" }))
    expect(api.updatePolicy).toHaveBeenCalledTimes(1)

    api.getPolicy.mockResolvedValueOnce({ enabled: false, offsetsDays: [14] })
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<ReminderPolicyCard />)
    await waitFor(() => expect(screen.getAllByRole("spinbutton").map((input) => (input as HTMLInputElement).value)).toEqual(["14"]))

    await act(async () => resolveSave({ enabled: true, offsetsDays: [-3, 7] }))

    // Organization B's policy stays on screen, with no success message from organization A's save.
    expect(screen.getAllByRole("spinbutton").map((input) => (input as HTMLInputElement).value)).toEqual(["14"])
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByText("reminders.policy.saved")).toBeNull()
    expect((screen.getByRole("button", { name: "reminders.policy.save" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
