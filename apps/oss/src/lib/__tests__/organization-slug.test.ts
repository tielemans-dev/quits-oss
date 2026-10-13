import { describe, expect, it, vi } from "vitest"
import {
  createNamedOrganization,
  isOrganizationSlug,
  organizationSlugCandidates,
  organizationSlugFromName,
} from "../organization-slug"

describe("organizationSlugFromName", () => {
  it("folds Danish names into a URL-safe slug", () => {
    expect(organizationSlugFromName("Nordlys Studio ApS")).toBe("nordlys-studio-aps")
    expect(organizationSlugFromName("  Høj & Æble Århus!! ")).toBe("hoej-aeble-aarhus")
    expect(organizationSlugFromName("   ")).toBe("organization")
    expect(isOrganizationSlug(organizationSlugFromName("Å"))).toBe(true)
  })

  it("keeps candidates unique and within the slug length", () => {
    const candidates = organizationSlugCandidates("A".repeat(80), 3)
    expect(candidates).toEqual(["a".repeat(48), `${"a".repeat(46)}-2`, `${"a".repeat(46)}-3`])
    expect(new Set(candidates).size).toBe(candidates.length)
    for (const slug of candidates) expect(isOrganizationSlug(slug)).toBe(true)
  })
})

describe("createNamedOrganization", () => {
  it("creates an organization after more than twelve slug collisions", async () => {
    const isSlugAvailable = vi.fn(async (slug: string) => slug === "acme-14")
    const create = vi.fn(async () => ({ ok: true as const, id: "org_14" }))
    await expect(createNamedOrganization({ name: "Acme", isSlugAvailable, create })).resolves.toEqual({
      ok: true, id: "org_14", slug: "acme-14",
    })
    expect(isSlugAvailable).toHaveBeenCalledTimes(14)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("uses the first free slug and names the organization after the company", async () => {
    const isSlugAvailable = vi.fn(async (slug: string) => slug !== "nordlys-aps")
    const create = vi.fn(async (body: { name: string; slug: string }) => ({ ok: true as const, id: "org_1", ...body }))
    await expect(createNamedOrganization({
      name: "  Nordlys ApS ",
      isSlugAvailable,
      create,
    })).resolves.toEqual({ ok: true, id: "org_1", slug: "nordlys-aps-2" })
    expect(create).toHaveBeenCalledWith({ name: "Nordlys ApS", slug: "nordlys-aps-2" })
  })

  it("retries when creation loses a race for the slug, and stops on other errors", async () => {
    const isSlugAvailable = vi.fn(async () => true)
    const create = vi.fn()
      .mockResolvedValueOnce({ ok: false, message: "Organization already exists" })
      .mockResolvedValueOnce({ ok: true, id: "org_2" })
    await expect(createNamedOrganization({ name: "Acme", isSlugAvailable, create })).resolves.toMatchObject({
      ok: true,
      id: "org_2",
      slug: "acme-2",
    })

    create.mockReset()
    create.mockResolvedValue({ ok: false, message: "Not allowed" })
    await expect(createNamedOrganization({ name: "Acme", isSlugAvailable, create })).resolves.toEqual({
      ok: false,
      message: "Not allowed",
    })
    expect(create).toHaveBeenCalledTimes(1)
  })
})
