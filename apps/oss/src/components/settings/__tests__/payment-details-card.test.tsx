// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))

vi.mock("../../../trpc/client", () => ({
  trpc: {
    paymentDetails: {
      get: { query: api.get },
      update: { mutate: api.update },
    },
  },
}))

const auth = vi.hoisted(() => ({
  session: { data: { session: { activeOrganizationId: "org_a" } }, isPending: false },
}))

vi.mock("../../../lib/auth-client", () => ({
  useSession: () => auth.session,
}))

// A stable translate function, as the real i18n context provides. Keys stand in for messages.
vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({ t: translate }),
}))

import { PaymentDetailsCard } from "../payment-details-card"

function translate(key: string) {
  return key
}

const empty = { bankAccount: null, note: null }
const complete = {
  bankAccount: {
    accountHolder: "Nordic Design ApS",
    bankName: "Danske Bank",
    regNumber: "0040",
    accountNumber: "0440116243",
    iban: "DK5000400440116243",
    bic: "DABADKKK",
  },
  note: "MobilePay Box 12345",
}
const noAccountFields = { accountHolder: null, bankName: null, regNumber: null, accountNumber: null, iban: null, bic: null }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  auth.session = { data: { session: { activeOrganizationId: "org_a" } }, isPending: false }
})

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement
const saveButton = () => screen.getByRole("button", { name: "settings.paymentDetails.save" }) as HTMLButtonElement
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } })

async function renderAs(state: typeof empty | typeof complete, options: { canUpdate?: boolean } = {}) {
  const canUpdate = options.canUpdate ?? true
  api.get.mockResolvedValue({ ...state, canUpdate })
  const view = render(<PaymentDetailsCard />)
  await waitFor(() => expect(api.get).toHaveBeenCalled())
  await screen.findByText("settings.paymentDetails.title")
  await waitFor(() => expect((field("settings.paymentDetails.iban.label") as HTMLInputElement).disabled).toBe(!canUpdate))
  return view
}

describe("PaymentDetailsCard", () => {
  it("shows the saved details, with the IBAN grouped as it is printed", async () => {
    await renderAs(complete)

    expect(field("settings.paymentDetails.regNumber.label").value).toBe("0040")
    expect(field("settings.paymentDetails.accountNumber.label").value).toBe("0440116243")
    expect(field("settings.paymentDetails.iban.label").value).toBe("DK50 0040 0440 1162 43")
    expect(field("settings.paymentDetails.bic.label").value).toBe("DABADKKK")
    expect(field("settings.paymentDetails.accountHolder.label").value).toBe("Nordic Design ApS")
    expect(field("settings.paymentDetails.bankName.label").value).toBe("Danske Bank")
    expect(field("settings.paymentDetails.note.label").value).toBe("MobilePay Box 12345")
  })

  it("groups the Danish account and the international transfer fields", async () => {
    await renderAs(empty)

    const danish = screen.getByRole("group", { name: "settings.paymentDetails.group.dk.title" })
    expect(within(danish).getByLabelText("settings.paymentDetails.regNumber.label")).toBeTruthy()
    expect(within(danish).getByLabelText("settings.paymentDetails.accountNumber.label")).toBeTruthy()
    const international = screen.getByRole("group", { name: "settings.paymentDetails.group.intl.title" })
    expect(within(international).getByLabelText("settings.paymentDetails.iban.label")).toBeTruthy()
    expect(within(international).getByLabelText("settings.paymentDetails.bic.label")).toBeTruthy()
  })

  it("previews the block as it will appear on invoices, updating while typing", async () => {
    await renderAs(empty)
    expect(screen.getByText("settings.paymentDetails.preview.empty")).toBeTruthy()
    expect(screen.queryByTestId("payment-details-preview")).toBeNull()

    type("settings.paymentDetails.iban.label", "dk50 0040 0440 1162 43")
    type("settings.paymentDetails.bic.label", "dabadkkk")
    type("settings.paymentDetails.note.label", "MobilePay Box 12345")

    const preview = screen.getByTestId("payment-details-preview")
    expect(within(preview).getByText("Payment details")).toBeTruthy()
    expect(within(preview).getByText("DK50 0040 0440 1162 43")).toBeTruthy()
    expect(within(preview).getByText("DABADKKK")).toBeTruthy()
    expect(within(preview).getByText("MobilePay Box 12345")).toBeTruthy()
    expect(preview.textContent).toContain("Payment reference: INV-0001")
    expect(screen.queryByText("settings.paymentDetails.preview.empty")).toBeNull()
  })

  it("saves the normalized details and reports success", async () => {
    await renderAs(empty)
    api.update.mockResolvedValue({
      bankAccount: { ...noAccountFields, iban: "DK5000400440116243", bic: "DABADKKK" },
      note: null,
      canUpdate: true,
    })

    expect(saveButton().disabled).toBe(true)
    type("settings.paymentDetails.iban.label", "dk50 0040 0440 1162 43")
    type("settings.paymentDetails.bic.label", " dabadkkk ")
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(saveButton())

    expect(await screen.findByText("settings.paymentDetails.saved")).toBeTruthy()
    expect(api.update).toHaveBeenCalledWith({
      bankAccount: { ...noAccountFields, iban: "DK5000400440116243", bic: "DABADKKK" },
      note: null,
    })
    expect(field("settings.paymentDetails.iban.label").value).toBe("DK50 0040 0440 1162 43")
    expect(saveButton().disabled).toBe(true)
  })

  it("does not save an IBAN with a wrong check digit and says why", async () => {
    await renderAs(empty)

    type("settings.paymentDetails.iban.label", "DK5000400440116244")
    // The error appears once the person leaves the field, not while still typing.
    expect(screen.queryByText("settings.paymentDetails.error.iban")).toBeNull()
    fireEvent.blur(field("settings.paymentDetails.iban.label"))
    expect(screen.getByText("settings.paymentDetails.error.iban")).toBeTruthy()
    expect(field("settings.paymentDetails.iban.label").getAttribute("aria-invalid")).toBe("true")

    fireEvent.click(saveButton())
    expect(api.update).not.toHaveBeenCalled()
  })

  it("asks for an IBAN or reg.nr. and account number once a bank name is entered", async () => {
    await renderAs(empty)

    type("settings.paymentDetails.bankName.label", "Danske Bank")
    fireEvent.click(saveButton())

    expect(screen.getByText("settings.paymentDetails.error.iban.required")).toBeTruthy()
    expect(api.update).not.toHaveBeenCalled()

    type("settings.paymentDetails.iban.label", "DK5000400440116243")
    expect(screen.queryByText("settings.paymentDetails.error.iban.required")).toBeNull()
  })

  it("rejects a DK IBAN with one digit too many", async () => {
    await renderAs(empty)
    type("settings.paymentDetails.iban.label", "DK50 0040 0440 1162 430")
    fireEvent.blur(field("settings.paymentDetails.iban.label"))
    expect(screen.getByText("settings.paymentDetails.error.iban")).toBeTruthy()
  })

  it("asks for the reg.nr. and account number together", async () => {
    await renderAs(empty)

    type("settings.paymentDetails.regNumber.label", "0040")
    fireEvent.click(saveButton())

    expect(screen.getByText("settings.paymentDetails.error.accountNumber.required")).toBeTruthy()
    // The missing counterpart is the problem, not a missing IBAN.
    expect(screen.queryByText("settings.paymentDetails.error.iban.required")).toBeNull()
    expect(api.update).not.toHaveBeenCalled()

    type("settings.paymentDetails.accountNumber.label", "0440116243")
    expect(screen.queryByText("settings.paymentDetails.error.accountNumber.required")).toBeNull()
  })

  it.each([
    ["settings.paymentDetails.regNumber.label", "123", "settings.paymentDetails.error.regNumber"],
    ["settings.paymentDetails.bic.label", "DABADKK", "settings.paymentDetails.error.bic"],
    ["settings.paymentDetails.note.label", "x".repeat(501), "settings.paymentDetails.error.note"],
  ])("rejects an invalid %s", async (label, value, errorKey) => {
    await renderAs(empty)
    type(label, value)
    if (label.includes("regNumber")) type("settings.paymentDetails.accountNumber.label", "0440116243")
    fireEvent.click(saveButton())
    expect(screen.getByText(errorKey)).toBeTruthy()
    expect(api.update).not.toHaveBeenCalled()
  })

  it("shows a server failure instead of success", async () => {
    await renderAs(empty)
    api.update.mockRejectedValue(new Error("Your role does not allow settings:update"))
    type("settings.paymentDetails.note.label", "Pay by transfer")
    fireEvent.click(saveButton())

    expect((await screen.findByRole("alert")).textContent).toBe("Your role does not allow settings:update")
    expect(screen.queryByText("settings.paymentDetails.saved")).toBeNull()
  })

  it.each(["member", "accountant"])("shows the details read-only to a %s", async () => {
    await renderAs(complete, { canUpdate: false })

    expect(screen.getByText("settings.paymentDetails.readOnly")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "settings.paymentDetails.save" })).toBeNull()
    for (const input of [...screen.getAllByRole("textbox")] as HTMLInputElement[]) {
      expect(input.disabled).toBe(true)
    }
    // Everyone can still see what invoices will show.
    expect(screen.getByTestId("payment-details-preview").textContent).toContain("DK50 0040 0440 1162 43")
  })

  it("reports a load failure", async () => {
    api.get.mockRejectedValue(new Error("offline"))
    render(<PaymentDetailsCard />)
    expect(await screen.findByText("settings.paymentDetails.error.load")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "settings.paymentDetails.save" })).toBeNull()
  })

  it("reloads and drops edit rights when the user switches organization", async () => {
    const { rerender } = await renderAs(complete)
    type("settings.paymentDetails.note.label", "Unsaved edit")
    expect(field("settings.paymentDetails.note.label").value).toBe("Unsaved edit")

    api.get.mockReturnValueOnce(new Promise(() => undefined))
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<PaymentDetailsCard />)

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole("button", { name: "settings.paymentDetails.save" })).toBeNull()
    expect((field("settings.paymentDetails.note.label") as HTMLTextAreaElement).disabled).toBe(true)
  })

  it("ignores a save response that arrives after the user switched organization", async () => {
    api.get.mockResolvedValueOnce({ ...empty, canUpdate: true })
    let resolveSave: (state: unknown) => void = () => undefined
    api.update.mockReturnValueOnce(new Promise((resolve) => (resolveSave = resolve)))
    const { rerender } = render(<PaymentDetailsCard />)
    await screen.findByText("settings.paymentDetails.title")
    await waitFor(() => expect((field("settings.paymentDetails.iban.label") as HTMLInputElement).disabled).toBe(false))
    type("settings.paymentDetails.note.label", "From organization A")
    fireEvent.click(saveButton())
    expect(api.update).toHaveBeenCalledTimes(1)

    api.get.mockResolvedValueOnce({ ...empty, note: "Organization B", canUpdate: true })
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<PaymentDetailsCard />)
    await waitFor(() => expect(field("settings.paymentDetails.note.label").value).toBe("Organization B"))

    await act(async () => resolveSave({ ...empty, note: "From organization A", canUpdate: true }))

    expect(field("settings.paymentDetails.note.label").value).toBe("Organization B")
    expect(screen.queryByText("settings.paymentDetails.saved")).toBeNull()
  })
})
