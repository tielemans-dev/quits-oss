import { afterEach, describe, expect, it } from "vitest"
import type { CvrCompany } from "@quits/contracts/cvr"
import { prisma } from "../../../lib/db"
import { resetRuntimeServices, setRuntimeServices } from "../../../lib/runtime/services"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

function company(overrides: Partial<CvrCompany> = {}): CvrCompany {
  return { cvr: "24256790", name: "Register A/S", address: "Vestergade 5\n8000 Aarhus C", companyForm: "A/S", status: "active", statusClass: "active", momsRegistered: true, ...overrides }
}

describeIfDatabase("customers from the CVR register", () => {
  const cleanups: Array<() => Promise<void>> = []
  let answer = company()
  afterEach(async () => {
    resetRuntimeServices()
    answer = company()
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function caller() {
    setRuntimeServices({ cvrLookupProvider: { search: async () => [answer], get: async () => answer } })
    const org = await createTestOrganization({ roles: ["admin"] })
    cleanups.push(org.cleanup)
    return appRouter.createCaller({
      session: {
        user: { id: org.actors.admin.userId, email: "admin@example.com", name: "admin" },
        session: { activeOrganizationId: org.organizationId },
      },
    } as never)
  }

  it("takes the CVR number and legal name from the register and bills the registered address", async () => {
    const api = await caller()
    const contact = await api.contacts.create({ name: "Mette Jensen", company: "Typed name", taxId: "11111111", registryCvr: "24256790" })
    expect(contact).toMatchObject({
      registrySource: "cvr", taxId: "24256790", company: "Register A/S", legalName: "Register A/S", name: "Mette Jensen",
      registeredAddress: "Vestergade 5", registeredZip: "8000", registeredCity: "Aarhus C",
      address: "Vestergade 5", zip: "8000", city: "Aarhus C", country: "DK",
    })
  })

  it("keeps the billing details editable and the register identity locked", async () => {
    const api = await caller()
    const contact = await api.contacts.create({ name: "Register A/S", registryCvr: "24256790" })
    const billed = await api.contacts.update({ id: contact.id, name: "Bogholderiet", email: "faktura@example.com", address: "Postboks 12", zip: "8100", city: "Aarhus C", taxId: "DK 24256790", company: "Register A/S" })
    expect(billed).toMatchObject({ address: "Postboks 12", registeredAddress: "Vestergade 5", email: "faktura@example.com" })
    await expect(api.contacts.update({ id: contact.id, taxId: "11111111" })).rejects.toThrow(/CVR number comes from the register/)
    await expect(api.contacts.update({ id: contact.id, company: "Another name" })).rejects.toThrow(/legal name comes from the register/)
  })

  it("leaves manual customers fully editable", async () => {
    const api = await caller()
    const contact = await api.contacts.create({ name: "Manual", company: "Manual ApS", taxId: "24256790", country: "DK" })
    expect(contact.registrySource).toBeNull()
    expect(await api.contacts.update({ id: contact.id, company: "Renamed ApS", taxId: "10150817" })).toMatchObject({ company: "Renamed ApS", taxId: "10150817" })
  })

  it("refreshes the identity and moves a billing address that followed the registered one", async () => {
    const api = await caller()
    const following = await api.contacts.create({ name: "A", registryCvr: "24256790" })
    const ownBilling = await api.contacts.update({ id: (await api.contacts.create({ name: "B", registryCvr: "24256790" })).id, address: "Postboks 12" })
    answer = company({ name: "Renamed A/S", address: "Nørregade 1, 1165 København K" })
    expect(await api.contacts.refreshFromCvr({ id: following.id })).toMatchObject({
      company: "Renamed A/S", legalName: "Renamed A/S", registeredAddress: "Nørregade 1", address: "Nørregade 1", zip: "1165", city: "København K",
    })
    expect(await api.contacts.refreshFromCvr({ id: ownBilling.id })).toMatchObject({ company: "Renamed A/S", registeredAddress: "Nørregade 1", address: "Postboks 12", zip: "8000" })
  })

  it("turns a manual Danish customer into a CVR customer and keeps its own address", async () => {
    const api = await caller()
    const manual = await api.contacts.create({ name: "Manual", company: "Old name", taxId: "DK24256790", address: "Strøget 1", zip: "1000", city: "København", country: "DK" })
    const refreshed = await api.contacts.refreshFromCvr({ id: manual.id })
    expect(refreshed).toMatchObject({ registrySource: "cvr", company: "Register A/S", taxId: "24256790", registeredAddress: "Vestergade 5", address: "Strøget 1" })
    expect(refreshed.registryCheckedAt).toBeInstanceOf(Date)
  })

  it("refuses an answer for another number and a customer without a CVR", async () => {
    const api = await caller()
    const contact = await api.contacts.create({ name: "A", registryCvr: "24256790" })
    answer = company({ cvr: "10150817" })
    await expect(api.contacts.refreshFromCvr({ id: contact.id })).rejects.toMatchObject({ code: "NOT_FOUND" })
    const foreign = await api.contacts.create({ name: "Foreign", country: "DE" })
    await expect(api.contacts.refreshFromCvr({ id: foreign.id })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).toMatchObject({ taxId: "24256790" })
  })
})
