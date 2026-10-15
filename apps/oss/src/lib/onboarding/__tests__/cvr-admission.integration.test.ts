import { randomInt, randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { betterAuth } from "better-auth"
import { isValidDanishCvr } from "@quits/contracts/onboarding"
import { prisma } from "../../db"
import { buildQuitsAuthOptions } from "../../runtime/auth-config"
import { setRuntimeExtensions } from "../../runtime/extensions"
import { resetRuntimeServices, setRuntimeServices } from "../../runtime/services"
import { assertOrganizationCvrAvailable, claimCvrTrial, isCvrTrialEligible } from "../../runtime/cvr-admission"
import { cleanupTestOrganizations, hasTestDatabase } from "../../../test-utils/organization"

const origin = "http://localhost:3154"
const ids: string[] = []
const users: string[] = []
let cvr: string
async function organization() {
  const id = randomUUID()
  ids.push(id)
  return prisma.organization.create({ data: { id, name: "Synthetic", slug: id, createdAt: new Date() } })
}
async function session(cloud = true) {
  const options = buildQuitsAuthOptions({ prisma, env: { getEnv: name => name === "BETTER_AUTH_URL" ? origin
    : name === "QUITS_DISTRIBUTION" ? (cloud ? "cloud" : "selfhost") : undefined } })
  const auth = betterAuth({ ...options, secret: "synthetic-cvr-admission-secret-at-least-32-chars", logger: { disabled: true } })
  const signup = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, { method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Test", email: `${randomUUID()}@example.test`, password: "local-password123" }) }))
  expect(signup.status).toBe(200)
  users.push((await signup.json()).user.id)
  const cookie = signup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
  return async () => {
    const slug = randomUUID()
    const response = await auth.handler(new Request(`${origin}/api/auth/organization/create`, { method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Synthetic", slug, metadata: { cvr } }) }))
    const org = await prisma.organization.findUnique({ where: { slug } })
    if (org) ids.push(org.id)
    return response
  }
}

;(hasTestDatabase ? describe : describe.skip)("CVR admission", () => {
  beforeEach(() => {
    do { cvr = String(randomInt(10_000_000, 99_999_999)) } while (!isValidDanishCvr(cvr))
    setRuntimeExtensions([{ id: "synthetic-hosted", enforceCvrUniqueness: true }])
    setRuntimeServices({ cvrLookupProvider: { search: async () => [], get: async value => ({ cvr: value,
      name: "Synthetic", address: "Testvej 1", companyForm: "ApS", status: "active", statusClass: "active", momsRegistered: true }) } })
  })
  afterEach(async () => {
    await cleanupTestOrganizations({ where: { id: { in: ids.splice(0) } } })
    await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } })
    await prisma.cvrTrialUsage.deleteMany({ where: { cvr } })
    setRuntimeExtensions([])
    resetRuntimeServices()
  })
  it("refuses a duplicate through hosted HTTP admission and cleans up the refused organization", async () => {
    const create = await session()
    expect((await create()).status).toBe(200)
    const duplicate = await create()
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({ code: "cvr.alreadyRegistered" })
    expect(await prisma.organizationTaxId.count({ where: { value: cvr } })).toBe(1)
    expect(ids).toHaveLength(1)
  })
  it("allows duplicates on self-host even when the extension is registered", async () => {
    const create = await session(false)
    expect((await create()).status).toBe(200)
    expect((await create()).status).toBe(200)
    expect(await prisma.organizationTaxId.count({ where: { value: cvr } })).toBe(2)
  })
  it("keeps hosted admission unchanged until the runtime opts in", async () => {
    setRuntimeExtensions([])
    const create = await session()
    expect((await create()).status).toBe(200)
    expect((await create()).status).toBe(200)
  })
  it("admits only one of two simultaneous hosted organization signups", async () => {
    const create = await session()
    const responses = await Promise.all([create(), create()])
    expect(responses.map(response => response.status).sort()).toEqual([200, 400])
    expect(await prisma.organizationTaxId.count({ where: { value: cvr } })).toBe(1)
    expect(ids).toHaveLength(1)
  })
  it("checks later verification against legacy Danish VAT aliases, excluding the same organization", async () => {
    const owner = await organization()
    const pending = await organization()
    await prisma.organizationTaxId.create({ data: { organizationId: owner.id, scheme: "VAT", value: `DK ${cvr}`, countryCode: null } })
    await expect(prisma.$transaction(tx => assertOrganizationCvrAvailable(tx, { cvr, cloud: true, organizationId: owner.id }))).resolves.toBeUndefined()
    await expect(prisma.$transaction(tx => assertOrganizationCvrAvailable(tx, { cvr, cloud: true, organizationId: pending.id })))
      .rejects.toMatchObject({ message: "cvr.alreadyRegistered" })
  })
  it("retains trial use after deletion, while allowing a replacement organization", async () => {
    const org = await organization()
    expect(await isCvrTrialEligible(prisma, cvr)).toBe(true)
    expect(await claimCvrTrial(prisma, cvr, org.id)).toBe(true)
    await prisma.organization.delete({ where: { id: org.id } })
    expect(await isCvrTrialEligible(prisma, cvr)).toBe(false)
    const replacement = await organization()
    expect(await claimCvrTrial(prisma, cvr, replacement.id)).toBe(false)
    await expect(prisma.$transaction(tx => assertOrganizationCvrAvailable(tx, { cvr, cloud: true, organizationId: replacement.id }))).resolves.toBeUndefined()
  })
  it("claims trial eligibility atomically and rolls back with its caller", async () => {
    const org = await organization()
    await expect(prisma.$transaction(async tx => { await claimCvrTrial(tx, cvr, org.id); throw new Error("rollback") })).rejects.toThrow("rollback")
    expect(await isCvrTrialEligible(prisma, cvr)).toBe(true)
    const claims = await Promise.all([claimCvrTrial(prisma, cvr, org.id), claimCvrTrial(prisma, cvr, org.id)])
    expect(claims.sort()).toEqual([false, true])
  })
})
