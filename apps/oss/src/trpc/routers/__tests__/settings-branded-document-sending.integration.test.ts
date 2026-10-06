import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { resetRuntimeServices, setRuntimeServices } from "../../../lib/runtime/services"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

function restoreEnv(previous: Record<string, string | undefined>) {
  process.env.RESEND_API_KEY = previous.RESEND_API_KEY
  process.env.FROM_EMAIL = previous.FROM_EMAIL
  process.env.YAIP_DISTRIBUTION = previous.YAIP_DISTRIBUTION
}

async function createOrgWithCaller(name: string) {
  const orgId = randomUUID()
  const slug = `settings-branded-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

  await prisma.organization.create({
    data: {
      id: orgId,
      name,
      slug,
      createdAt: new Date(),
      subscriptionStatus: "pro",
    },
  })
  await ensureTestMembership(orgId, `${name}-user`)

  await prisma.orgSettings.create({
    data: {
      organizationId: orgId,
      companyName: "Acme",
      companyEmail: "billing@acme.com",
    },
  })

  return {
    orgId,
    caller: appRouter.createCaller({
      session: {
        user: {
          id: `${name}-user`,
          email: `${slug}@example.com`,
          name,
        },
        session: {
          activeOrganizationId: orgId,
        },
      },
    } as never),
  }
}

describeIfDatabase("settings branded document sending", () => {
  afterEach(() => {
    resetRuntimeServices()
    setRuntimeExtensions([])
    delete process.env.RESEND_API_KEY
    delete process.env.FROM_EMAIL
    delete process.env.YAIP_DISTRIBUTION
  })

  it("returns shared-sender-only state in OSS mode", async () => {
    const previous = {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
      YAIP_DISTRIBUTION: process.env.YAIP_DISTRIBUTION,
    }

    process.env.RESEND_API_KEY = "re_test_123456789"
    process.env.FROM_EMAIL = "billing@yaip.example"

    const { orgId, caller } = await createOrgWithCaller("OSS Branded Settings Org")

    try {
      const settings = await caller.settings.get()

      expect(settings.documentSending).toEqual({
        managed: false,
        supportsCustomDomain: false,
        status: "not_configured",
        requestedDomain: null,
        records: [],
        failureReason: null,
        verifiedAt: null,
        lastSyncedAt: null,
        lastSyncSource: null,
        sharedSender: {
          fromName: "Acme via YAIP",
          fromEmail: "billing@yaip.example",
          replyTo: "billing@acme.com",
          usingBrandedDomain: false,
        },
        effectiveSender: {
          fromName: "Acme via YAIP",
          fromEmail: "billing@yaip.example",
          replyTo: "billing@acme.com",
          usingBrandedDomain: false,
        },
      })
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("returns managed branded-email capability state in cloud mode", async () => {
    const previous = {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
      YAIP_DISTRIBUTION: process.env.YAIP_DISTRIBUTION,
    }

    process.env.RESEND_API_KEY = "re_test_123456789"
    process.env.FROM_EMAIL = "billing@yaip.example"
    process.env.YAIP_DISTRIBUTION = "cloud"
    setRuntimeExtensions([
      {
        id: "test-cloud-email",
        resolveCapabilities: () => ({
          emailDelivery: {
            managed: true,
          },
        }),
      },
    ])
    setRuntimeServices({
      managedDocumentDomainProvider: {
        supported: true,
        createDomain: async ({ domain }) => ({
          providerId: "dom_123",
          domain,
          status: "pending_dns",
          records: [],
          failureReason: null,
          verifiedAt: null,
        }),
        refreshDomain: async ({ domain }) => ({
          providerId: "dom_123",
          domain,
          status: "verified",
          records: [],
          failureReason: null,
          verifiedAt: new Date("2026-03-06T18:00:00.000Z"),
        }),
        deleteDomain: async () => {},
      },
    })

    const { orgId, caller } = await createOrgWithCaller("Cloud Branded Settings Org")

    try {
      const settings = await caller.settings.get()

      expect(settings.documentSending.managed).toBe(true)
      expect(settings.documentSending.supportsCustomDomain).toBe(true)
      expect(settings.documentSending.lastSyncedAt).toBeNull()
      expect(settings.documentSending.lastSyncSource).toBeNull()
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("configures and persists a branded sending domain", async () => {
    const createDomain = vi.fn(async ({ domain }: { domain: string }) => ({
      providerId: "dom_123",
      domain,
      status: "pending_dns" as const,
      records: [
        {
          name: "send.billing.acme.com",
          type: "TXT",
          value: "v=spf1 include:amazonses.com ~all",
          ttl: 300,
          status: "pending",
        },
      ],
      failureReason: null,
      verifiedAt: null,
    }))
    setRuntimeServices({
      managedDocumentDomainProvider: {
        supported: true,
        createDomain,
        refreshDomain: async ({ domain }) => ({
          providerId: "dom_123",
          domain,
          status: "verified",
          records: [],
          failureReason: null,
          verifiedAt: new Date("2026-03-06T18:00:00.000Z"),
        }),
        deleteDomain: async () => {},
      },
    })

    const { orgId, caller } = await createOrgWithCaller("Configure Branded Settings Org")

    try {
      const result = await caller.settings.configureDocumentSendingDomain({
        domain: "billing.acme.com",
      })

      expect(createDomain).toHaveBeenCalledWith({ domain: "billing.acme.com" })
      expect(result.status).toBe("pending_dns")
      expect(result.requestedDomain).toBe("billing.acme.com")

      const stored = await prisma.orgSettings.findUniqueOrThrow({
        where: { organizationId: orgId },
        select: {
          documentSendingDomain: true,
          documentSendingDomainProviderId: true,
          documentSendingDomainStatus: true,
        },
      })

      expect(stored).toEqual({
        documentSendingDomain: "billing.acme.com",
        documentSendingDomainProviderId: "dom_123",
        documentSendingDomainStatus: "pending_dns",
      })
    } finally {
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("refreshes branded sending status to verified", async () => {
    const refreshDomain = vi.fn(async ({ domain }: { providerId: string; domain: string }) => ({
      providerId: "dom_123",
      domain,
      status: "verified" as const,
      records: [],
      failureReason: null,
      verifiedAt: new Date("2026-03-06T18:00:00.000Z"),
    }))
    setRuntimeServices({
      managedDocumentDomainProvider: {
        supported: true,
        createDomain: async ({ domain }) => ({
          providerId: "dom_123",
          domain,
          status: "pending_dns",
          records: [],
          failureReason: null,
          verifiedAt: null,
        }),
        refreshDomain,
        deleteDomain: async () => {},
      },
    })

    const { orgId, caller } = await createOrgWithCaller("Refresh Branded Settings Org")
    await prisma.orgSettings.update({
      where: { organizationId: orgId },
      data: {
        documentSendingDomain: "billing.acme.com",
        documentSendingDomainProviderId: "dom_123",
        documentSendingDomainStatus: "pending_dns",
        documentSendingLastSyncedAt: new Date("2026-03-06T17:30:00.000Z"),
        documentSendingLastSyncSource: "webhook",
      },
    })

    try {
      const result = await caller.settings.refreshDocumentSendingDomain()

      expect(refreshDomain).toHaveBeenCalledWith({
        providerId: "dom_123",
        domain: "billing.acme.com",
      })
      expect(result.status).toBe("verified")
      expect(result.verifiedAt).toBeInstanceOf(Date)
      expect(result.lastSyncSource).toBe("manual")
      expect(result.lastSyncedAt).toBeInstanceOf(Date)

      const stored = await prisma.orgSettings.findUniqueOrThrow({
        where: { organizationId: orgId },
        select: {
          documentSendingLastSyncedAt: true,
          documentSendingLastSyncSource: true,
        },
      })

      expect(stored.documentSendingLastSyncedAt).toBeInstanceOf(Date)
      expect(stored.documentSendingLastSyncSource).toBe("manual")
    } finally {
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("disables branded sending and clears provider state", async () => {
    const deleteDomain = vi.fn(async () => {})
    setRuntimeServices({
      managedDocumentDomainProvider: {
        supported: true,
        createDomain: async ({ domain }) => ({
          providerId: "dom_123",
          domain,
          status: "pending_dns",
          records: [],
          failureReason: null,
          verifiedAt: null,
        }),
        refreshDomain: async ({ domain }) => ({
          providerId: "dom_123",
          domain,
          status: "verified",
          records: [],
          failureReason: null,
          verifiedAt: new Date("2026-03-06T18:00:00.000Z"),
        }),
        deleteDomain,
      },
    })

    const { orgId, caller } = await createOrgWithCaller("Disable Branded Settings Org")
    await prisma.orgSettings.update({
      where: { organizationId: orgId },
      data: {
        documentSendingDomain: "billing.acme.com",
        documentSendingDomainProviderId: "dom_123",
        documentSendingDomainStatus: "verified",
      },
    })

    try {
      const result = await caller.settings.disableDocumentSendingDomain()

      expect(deleteDomain).toHaveBeenCalledWith({
        providerId: "dom_123",
        domain: "billing.acme.com",
      })
      expect(result.status).toBe("not_configured")
      expect(result.requestedDomain).toBeNull()

      const stored = await prisma.orgSettings.findUniqueOrThrow({
        where: { organizationId: orgId },
        select: {
          documentSendingDomain: true,
          documentSendingDomainProviderId: true,
          documentSendingDomainStatus: true,
        },
      })

      expect(stored).toEqual({
        documentSendingDomain: null,
        documentSendingDomainProviderId: null,
        documentSendingDomainStatus: null,
      })
    } finally {
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })
})
