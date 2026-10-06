import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("contact Peppol endpoints", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function adminCaller() {
    const org = await createTestOrganization({ roles: ["admin"] })
    cleanups.push(org.cleanup)
    return appRouter.createCaller({
      session: {
        user: { id: org.actors.admin.userId, email: "admin@example.com", name: "admin" },
        session: { activeOrganizationId: org.organizationId },
      },
    } as never)
  }

  it("clears a saved endpoint with null and keeps it when the fields are omitted", async () => {
    const caller = await adminCaller()
    const contact = await caller.contacts.create({
      name: "Acme",
      peppolEndpointId: "5790000000005",
      peppolEndpointScheme: "0088",
    })

    const renamed = await caller.contacts.update({ id: contact.id, name: "Acme A/S" })
    expect(renamed).toMatchObject({ peppolEndpointId: "5790000000005", peppolEndpointScheme: "0088" })

    const cleared = await caller.contacts.update({
      id: contact.id,
      peppolEndpointId: null,
      peppolEndpointScheme: null,
    })
    expect(cleared).toMatchObject({ peppolEndpointId: null, peppolEndpointScheme: null })
  })

  it("rejects unknown schemes and endpoint IDs that do not fit the stored scheme", async () => {
    const caller = await adminCaller()
    await expect(
      caller.contacts.create({ name: "Acme", peppolEndpointId: "12345678", peppolEndpointScheme: "1234" })
    ).rejects.toThrow()

    const contact = await caller.contacts.create({
      name: "Acme",
      peppolEndpointId: "12345678",
      peppolEndpointScheme: "0184",
    })
    await expect(caller.contacts.update({ id: contact.id, peppolEndpointId: "1234" })).rejects.toThrow(
      /does not match/
    )
    await expect(caller.contacts.update({ id: contact.id, peppolEndpointScheme: null })).rejects.toThrow(
      /both/
    )
  })
})
