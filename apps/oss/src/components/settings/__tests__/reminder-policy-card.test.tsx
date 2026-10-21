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

import { translate as catalogTranslate } from "../../../lib/i18n/translate"
import { describeReminderOffset, ReminderPolicyCard } from "../reminder-policy-card"
import { handledMutationError } from "../../../lib/query-refresh"

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

    expect(await screen.findByRole("button", { name: "reminder.save" })).toBeTruthy()
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
    expect(screen.queryByRole("button", { name: "reminder.save" })).toBeNull()
    expect(screen.queryByRole("button", { name: "reminders.policy.offsets.add" })).toBeNull()
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByRole("spinbutton")).toBeNull()
    for (const button of screen.getAllByRole("button", { name: "reminder.remove" }) as HTMLButtonElement[]) expect(button.disabled).toBe(true)
  })

  it("reloads the policy and drops edit rights when the user switches organization", async () => {
    api.getPolicy.mockResolvedValueOnce({ enabled: true, offsetsDays: [-3, 7] })
    api.capabilities.mockResolvedValueOnce({ canSendNow: true, canPause: true, canUpdatePolicy: true })
    const { rerender } = render(<ReminderPolicyCard />)
    expect(await screen.findByRole("button", { name: "reminder.save" })).toBeTruthy()

    api.getPolicy.mockReturnValueOnce(new Promise(() => undefined))
    api.capabilities.mockResolvedValueOnce({ canSendNow: false, canPause: false, canUpdatePolicy: false })
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<ReminderPolicyCard />)

    expect(screen.queryByRole("button", { name: "reminder.save" })).toBeNull()
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

    expect(await screen.findByRole("button", { name: "reminder.save" })).toBeTruthy()
  })

  it("ignores a save response that arrives after the user switched organization", async () => {
    const admin = { canSendNow: true, canPause: true, canResume: true, canUpdatePolicy: true }
    api.getPolicy.mockResolvedValueOnce({ enabled: true, offsetsDays: [-3, 7] })
    api.capabilities.mockResolvedValue(admin)
    let resolveSave: (policy: { enabled: boolean; offsetsDays: number[] }) => void = () => undefined
    api.updatePolicy.mockReturnValueOnce(new Promise((resolve) => (resolveSave = resolve)))
    const { rerender } = render(<ReminderPolicyCard />)
    fireEvent.click(await screen.findByRole("button", { name: "reminder.save" }))
    expect(api.updatePolicy).toHaveBeenCalledTimes(1)

    api.getPolicy.mockResolvedValueOnce({ enabled: false, offsetsDays: [14] })
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<ReminderPolicyCard />)
    await waitFor(() => expect(Array.from(document.querySelectorAll("[data-slot=reminder-offset]")).map(row => row.getAttribute("data-offset-days"))).toEqual(["14"]))

    await act(async () => resolveSave({ enabled: true, offsetsDays: [-3, 7] }))

    // Organization B's policy stays on screen, with no success message from organization A's save.
    expect(Array.from(document.querySelectorAll("[data-slot=reminder-offset]")).map(row => row.getAttribute("data-offset-days"))).toEqual(["14"])
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByText("reminders.policy.saved")).toBeNull()
    expect((screen.getByRole("button", { name: "reminder.save" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("ignores an older save after switching A -> B -> A and saving again", async () => {
    const admin = { canSendNow: true, canPause: true, canResume: true, canUpdatePolicy: true }
    const values = () => Array.from(document.querySelectorAll("[data-slot=reminder-offset]")).map(row => row.getAttribute("data-offset-days"))
    api.capabilities.mockResolvedValue(admin)
    api.getPolicy.mockResolvedValueOnce({ enabled: true, offsetsDays: [-3, 7] })
    let resolveFirstSave: (policy: { enabled: boolean; offsetsDays: number[] }) => void = () => undefined
    api.updatePolicy.mockReturnValueOnce(new Promise((resolve) => (resolveFirstSave = resolve)))
    const { rerender } = render(<ReminderPolicyCard />)
    fireEvent.click(await screen.findByRole("button", { name: "reminder.save" }))

    api.getPolicy.mockResolvedValueOnce({ enabled: false, offsetsDays: [14] })
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<ReminderPolicyCard />)
    await waitFor(() => expect(values()).toEqual(["14"]))

    api.getPolicy.mockResolvedValueOnce({ enabled: true, offsetsDays: [30] })
    auth.session = { data: { session: { activeOrganizationId: "org_a" } }, isPending: false }
    rerender(<ReminderPolicyCard />)
    await waitFor(() => expect(values()).toEqual(["30"]))

    // A newer save for organization A finishes first.
    api.updatePolicy.mockResolvedValueOnce({ enabled: true, offsetsDays: [30] })
    fireEvent.click(screen.getByRole("button", { name: "reminder.save" }))
    expect(await screen.findByText("reminders.policy.saved")).toBeTruthy()

    // The first save's late response must not overwrite the newer policy.
    await act(async () => resolveFirstSave({ enabled: true, offsetsDays: [-3, 7] }))
    expect(values()).toEqual(["30"])
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true)
  })
})


describe("reminder schedule copy", () => {
  it.each([
    [-1, "1 dag før forfald", "1 day before due date"],
    [-3, "3 dage før forfald", "3 days before due date"],
    [0, "På forfaldsdagen", "On the due date"],
    [1, "1 dag efter forfald", "1 day after due date"],
    [7, "7 dage efter forfald", "7 days after due date"],
  ] as const)("maps offset %s using final da/en copy", (offset, da, en) => {
    expect(describeReminderOffset(offset, (key, vars) => catalogTranslate(key, "da-DK", vars))).toBe(da)
    expect(describeReminderOffset(offset, (key, vars) => catalogTranslate(key, "en-US", vars))).toBe(en)
  })

  it("edits a schedule row, adds onDue, removes a row and saves numeric offsets", async () => {
    api.getPolicy.mockResolvedValue({ enabled: true, offsetsDays: [-3, 7] })
    api.capabilities.mockResolvedValue({ canUpdatePolicy: true })
    api.updatePolicy.mockImplementation(async input => input)
    render(<ReminderPolicyCard />)
    fireEvent.click(await screen.findByRole("button", { name: "reminder.before.other" }))
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-1" } })
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" })
    expect(screen.getByRole("button", { name: "reminder.before.one" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "reminders.policy.offsets.add" }))
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } })
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" })
    expect(screen.getByRole("button", { name: "reminder.onDue" })).toBeTruthy()
    fireEvent.click(screen.getAllByRole("button", { name: "reminder.remove" })[1]!)
    fireEvent.click(screen.getByRole("button", { name: "reminder.save" }))
    await waitFor(() => expect(api.updatePolicy).toHaveBeenCalledWith({ enabled: true, offsetsDays: [-1, 0] }, handledMutationError))
  })
})
