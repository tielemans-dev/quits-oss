import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "../../init"
import type { UserActor } from "../../../domain/actor"
import { onboardingRouter } from "../onboarding"

const mocks = vi.hoisted(() => ({ settings: null as Record<string, unknown> | null, creates: [] as Array<Record<string, unknown>>, baseCurrency: "DKK" }))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.context<Context>().create()
  const actor: UserActor = { kind: "user", organizationId: "org-121", userId: "user-121", roles: ["admin"], label: "Test User" }
  const procedure = t.procedure.use(({ next }) => next({ ctx: {
    organizationId: actor.organizationId,
    user: { id: actor.userId, email: "signup@example.test", name: actor.label },
    actor,
  } }))
  return { router: t.router, authorizedProcedure: () => procedure }
})
vi.mock("../../../lib/distribution", () => ({ isCloudDistribution: true }))
vi.mock("../../../lib/runtime/extensions", () => ({ getRuntimeCapabilities: () => ({ onboardingV2: { enabled: false } }) }))
vi.mock("../../../lib/onboarding/confirm-v2", () => ({ confirmOnboardingV2: vi.fn() }))
vi.mock("../../../lib/billing", () => ({ billingProvider: {} }))
vi.mock("../../../domain/documents/base-currency", () => ({ resolveBaseCurrency: async () => mocks.baseCurrency }))
vi.mock("../../../lib/db", () => {
  // Independent schema keys catch invalid create fields even when upsert updates an existing row.
  const schema = readFileSync(new URL("../../../../prisma/schema.prisma", import.meta.url), "utf8")
  const model = schema.match(/model OrgSettings \{([\s\S]*?)\n\}/)![1]!
  const scalarKeys = new Set([...model.matchAll(/^\s+(\w+)\s+(?:String|Int|Float|Decimal|Boolean|DateTime|Json)\??\s/gm)].map(match => match[1]))
  const db = {
    orgSettings: {
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        for (const key of Object.keys(create)) {
          if (!scalarKeys.has(key)) throw new Error(`Unknown argument ${key} in OrgSettings.create`)
        }
        mocks.creates.push(create)
        mocks.settings = mocks.settings ? { ...mocks.settings, ...update } : { ...create }
        return mocks.settings
      },
    },
    organizationTaxId: { findFirst: async () => null, deleteMany: async () => ({ count: 0 }) },
    $queryRaw: async () => [],
    $transaction: async (run: (tx: unknown) => unknown) => run(db),
  }
  return { prisma: db }
})
const caller = () => onboardingRouter.createCaller({ session: null } satisfies Context)
const defaults = { countryCode: "DK", defaultCurrency: "DKK", baseCurrency: "DKK", currency: "DKK", locale: "da-DK", timezone: "Europe/Copenhagen", taxRegime: "eu_vat", pricesIncludeTax: false, taxRate: 25 }

describe("onboarding Prisma create payloads", () => {
  beforeEach(() => { mocks.settings = null; mocks.creates = []; mocks.baseCurrency = "DKK" })
  it("persists valid Danish defaults on the first legacy status read", async () => {
    const status = await caller().getStatus()
    expect(status.values).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK" })
    expect(mocks.settings).toMatchObject(defaults)
    expect(mocks.creates).toHaveLength(1)
  })
  it("validates draft creates and preserves explicit overrides and resolved non-DK books", async () => {
    mocks.baseCurrency = "EUR"
    await caller().saveDraft({ countryCode: "DE", locale: "en-US", defaultCurrency: "EUR", pricesIncludeTax: true, primaryTaxId: undefined })
    expect(mocks.creates).toHaveLength(3)
    expect(mocks.creates[1]).toMatchObject({ ...defaults, countryCode: "DE", locale: "en-US", defaultCurrency: "EUR", baseCurrency: "EUR", pricesIncludeTax: true })
    expect(mocks.settings).toMatchObject({ countryCode: "DE", baseCurrency: "EUR", defaultCurrency: "EUR", pricesIncludeTax: true })
  })
  it("validates profile completion creates even with an existing row", async () => {
    await caller().getStatus()
    await caller().complete({ profile: "smb" })
    expect(mocks.creates).toHaveLength(4)
    expect(mocks.creates[2]).toMatchObject({ countryCode: "DK", baseCurrency: "DKK", currency: "DKK", defaultCurrency: "DKK", taxRegime: "eu_vat" })
  })
})
