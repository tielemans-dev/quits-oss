import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  orgSettingsFindUnique: vi.fn(),
  organizationTaxIdFindFirst: vi.fn(),
}))

vi.mock("../db", () => ({
  prisma: {
    orgSettings: { findUnique: db.orgSettingsFindUnique },
    organizationTaxId: { findFirst: db.organizationTaxIdFindFirst },
  },
}))

import { loadCloudOnboardingState } from "../cloud-onboarding-session"

function completeSettings() {
  return {
    onboardingStatus: "complete",
    onboardingMethod: null,
    onboardingProfile: "smb",
    onboardingInvoicingIdentity: null,
    onboardingVersion: 1,
    onboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
    countryCode: null,
    locale: null,
    timezone: null,
    defaultCurrency: null,
    taxRegime: null,
    pricesIncludeTax: null,
    companyName: null,
    companyAddress: null,
    companyEmail: null,
    invoicePrefix: null,
    invoiceNextNum: null,
    quotePrefix: null,
    quoteNextNum: null,
  }
}

beforeEach(() => {
  db.orgSettingsFindUnique.mockReset()
  db.organizationTaxIdFindFirst.mockReset()
})

describe("loadCloudOnboardingState", () => {
  it("does not query the database without an active organization", async () => {
    const state = await loadCloudOnboardingState(null)
    expect(state.isComplete).toBe(false)
    expect(db.orgSettingsFindUnique).not.toHaveBeenCalled()
    expect(db.organizationTaxIdFindFirst).not.toHaveBeenCalled()
  })

  it("starts both independent queries before either one resolves", async () => {
    let releaseSettings: (value: unknown) => void = () => undefined
    let releaseTaxId: (value: unknown) => void = () => undefined
    db.orgSettingsFindUnique.mockReturnValue(new Promise((resolve) => (releaseSettings = resolve)))
    db.organizationTaxIdFindFirst.mockReturnValue(new Promise((resolve) => (releaseTaxId = resolve)))

    const pending = loadCloudOnboardingState("org_a")

    // Both queries are issued while neither has resolved, so they run concurrently.
    await vi.waitFor(() => {
      expect(db.orgSettingsFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org_a" } }))
      expect(db.organizationTaxIdFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: "org_a" } })
      )
    })

    releaseSettings(completeSettings())
    releaseTaxId({ value: "TAX-1" })
    const state = await pending
    expect(state.status).toBe("complete")
  })

  it("reports the primary tax id to the readiness check when settings exist", async () => {
    db.orgSettingsFindUnique.mockResolvedValue(completeSettings())
    db.organizationTaxIdFindFirst.mockResolvedValue({ value: "TAX-1" })

    const state = await loadCloudOnboardingState("org_a")
    expect(state.status).toBe("complete")
    expect(state.profile).toBe("smb")
  })

  it("reports not started when the organization has no settings row", async () => {
    db.orgSettingsFindUnique.mockResolvedValue(null)
    db.organizationTaxIdFindFirst.mockResolvedValue(null)

    const state = await loadCloudOnboardingState("org_a")
    expect(state.isComplete).toBe(false)
    expect(state.status).toBe("not_started")
  })
})
