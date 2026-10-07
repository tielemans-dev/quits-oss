import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

function clearEmailEnv() {
  delete process.env.RESEND_API_KEY
  delete process.env.FROM_EMAIL
  delete process.env.QUITS_DISTRIBUTION
  delete process.env.EMAIL_PROVIDER
  delete process.env.SMTP_HOST
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASSWORD
}

async function createOrgWithCaller(name: string) {
  const orgId = randomUUID()
  const slug = `settings-email-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

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

describeIfDatabase("settings email delivery status", () => {
  afterEach(() => {
    clearEmailEnv()
    setRuntimeExtensions([])
  })

  it("reports configured SMTP without a Resend key and never exposes relay credentials", async () => {
    process.env.EMAIL_PROVIDER = "smtp"
    process.env.SMTP_HOST = "relay.example.com"
    process.env.SMTP_USER = "smtp-user"
    process.env.SMTP_PASSWORD = "synthetic-smtp-password"
    process.env.FROM_EMAIL = "billing@acme.example"
    const { orgId, caller } = await createOrgWithCaller("Settings SMTP Org")
    try {
      const settings = await caller.settings.get()
      expect(settings.emailDelivery).toMatchObject({ managed: false, configured: true, available: true, missing: [], status: "configured" })
      expect(JSON.stringify(settings)).not.toContain("synthetic-smtp-password")
      expect(JSON.stringify(settings.emailDelivery)).not.toContain("smtp-user")
    } finally {
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("reports configured OSS email delivery when required env vars are present", async () => {
    process.env.RESEND_API_KEY = "re_test_123456789"
    process.env.FROM_EMAIL = "billing@acme.example"

    const { orgId, caller } = await createOrgWithCaller("Settings Email Configured Org")

    try {
      const settings = await caller.settings.get()

      expect(settings.emailDelivery).toEqual({
        managed: false,
        configured: true,
        available: true,
        sender: "billing@acme.example",
        missing: [],
        status: "configured",
      })
    } finally {
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("reports missing OSS configuration and the missing env var names", async () => {
    const { orgId, caller } = await createOrgWithCaller("Settings Email Missing Org")

    try {
      const settings = await caller.settings.get()

      expect(settings.emailDelivery).toEqual({
        managed: false,
        configured: false,
        available: false,
        sender: "noreply@yaip.app",
        missing: ["FROM_EMAIL", "RESEND_API_KEY"],
        status: "missing_configuration",
      })
    } finally {
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("reports managed cloud email delivery without exposing env diagnostics", async () => {
    process.env.RESEND_API_KEY = "re_test_123456789"
    process.env.FROM_EMAIL = "cloud@yaip.example"
    process.env.QUITS_DISTRIBUTION = "cloud"
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

    const { orgId, caller } = await createOrgWithCaller("Settings Email Managed Org")

    try {
      const settings = await caller.settings.get()

      expect(settings.emailDelivery).toEqual({
        managed: true,
        configured: true,
        available: true,
        sender: "cloud@yaip.example",
        missing: [],
        status: "managed",
      })
    } finally {
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })
})
