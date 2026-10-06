import { describe, expect, it } from "vitest"
import { contactCreateInputSchema, contactUpdateInputSchema } from "./contacts"

describe("contact contracts", () => {
  it("accepts Peppol endpoints whose scheme is on the EAS code list", () => {
    expect(
      contactCreateInputSchema.safeParse({
        name: "Acme",
        peppolEndpointId: "5790000000005",
        peppolEndpointScheme: "0088",
      }).success
    ).toBe(true)
  })

  it("rejects unknown EAS codes and endpoint IDs that do not fit the scheme", () => {
    const unknownScheme = contactCreateInputSchema.safeParse({
      name: "Acme",
      peppolEndpointId: "12345678",
      peppolEndpointScheme: "1234",
    })
    expect(unknownScheme.success).toBe(false)
    expect(unknownScheme.error?.issues.map((issue) => issue.path.join("."))).toContain("peppolEndpointScheme")

    const badId = contactCreateInputSchema.safeParse({
      name: "Acme",
      peppolEndpointId: "1234",
      peppolEndpointScheme: "0184",
    })
    expect(badId.success).toBe(false)
    expect(badId.error?.issues.map((issue) => issue.path.join("."))).toContain("peppolEndpointId")
  })

  it("rejects endpoint IDs that break the PEPPOL-COMMON rules", () => {
    for (const [id, scheme] of [
      ["NL12", "9944"],
      ["123456789", "0192"],
      ["5790000000001", "0088"],
    ]) {
      const result = contactCreateInputSchema.safeParse({ name: "Acme", peppolEndpointId: id, peppolEndpointScheme: scheme })
      expect(result.success).toBe(false)
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("peppolEndpointId")
    }
  })

  it("requires the endpoint ID and scheme together", () => {
    expect(contactCreateInputSchema.safeParse({ name: "Acme", peppolEndpointId: "12345678" }).success).toBe(false)
    expect(contactCreateInputSchema.safeParse({ name: "Acme", peppolEndpointScheme: "0184" }).success).toBe(false)
  })

  it("lets an update clear the endpoint with null and leave it unchanged when omitted", () => {
    const cleared = contactUpdateInputSchema.safeParse({
      id: "c1",
      peppolEndpointId: null,
      peppolEndpointScheme: null,
    })
    expect(cleared.success).toBe(true)
    expect(cleared.data).toMatchObject({ peppolEndpointId: null, peppolEndpointScheme: null })

    const unchanged = contactUpdateInputSchema.safeParse({ id: "c1", name: "Acme" })
    expect(unchanged.success).toBe(true)
    expect(unchanged.data?.peppolEndpointId).toBeUndefined()

    expect(
      contactUpdateInputSchema.safeParse({ id: "c1", peppolEndpointId: null, peppolEndpointScheme: "0184" }).success
    ).toBe(false)
  })
})
