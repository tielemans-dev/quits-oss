import "dotenv/config"
import { randomUUID } from "node:crypto"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { appRouter } from "../../router"
import { prisma } from "../../../lib/db"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

const TEST_SLUG_PREFIX = "setup-test-"
const TEST_EMAIL_PREFIX = "setup-test-"

async function ensureInstallationStateTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "installation_state" (
      "id" TEXT NOT NULL DEFAULT 'default',
      "isSetupComplete" BOOLEAN NOT NULL DEFAULT false,
      "distribution" TEXT NOT NULL DEFAULT 'selfhost',
      "setupVersion" INTEGER NOT NULL DEFAULT 1,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "installation_state_pkey" PRIMARY KEY ("id")
    )
  `)
}

async function cleanupSetupData() {
  const testOrganizations = await prisma.organization.findMany({
    where: {
      slug: {
        startsWith: TEST_SLUG_PREFIX,
      },
    },
    select: { id: true },
  })

  const testOrganizationIds = testOrganizations.map((org) => org.id)

  if (testOrganizationIds.length > 0) {
    await prisma.organization.deleteMany({
      where: {
        id: {
          in: testOrganizationIds,
        },
      },
    })
  }

  await prisma.user.deleteMany({
    where: {
      email: {
        startsWith: TEST_EMAIL_PREFIX,
      },
    },
  })

  await prisma.installationState.deleteMany()
}

describeIfDatabase("setup router integration", () => {
  const caller = appRouter.createCaller({ session: null } as never)

  beforeEach(async () => {
    await ensureInstallationStateTable()
    await cleanupSetupData()
    await prisma.installationState.upsert({
      where: { id: "default" },
      update: {
        isSetupComplete: false,
        distribution: "selfhost",
        setupVersion: 1,
      },
      create: {
        id: "default",
        isSetupComplete: false,
        distribution: "selfhost",
        setupVersion: 1,
      },
    })
  })

  afterEach(async () => {
    await cleanupSetupData()
  })

  it("initializes setup and marks installation complete", async () => {
    const seed = randomUUID()
    const setupInput = {
      instanceProfile: "smb" as const,
      organization: {
        name: `Setup Org ${seed.slice(0, 8)}`,
        slug: `${TEST_SLUG_PREFIX}${seed.slice(0, 12)}`,
      },
      admin: {
        name: "Setup Admin",
        email: `${TEST_EMAIL_PREFIX}${seed}@example.com`,
        password: "Passw0rd!234",
      },
      auth: {
        mode: "local_only" as const,
      },
      locale: {
        locale: "en-US",
        countryCode: "US",
        timezone: "UTC",
        currency: "USD",
      },
      email: {
        fromName: "Setup Billing",
        replyTo: "billing-setup@example.com",
      },
    }

    const initialStatus = await caller.setup.getStatus()

    if (initialStatus.stage === "new") {
      const initialized = await caller.setup.initialize(setupInput)
      expect(initialized.stage).toBe("initialized")
      expect(initialized.isSetupComplete).toBe(false)
      expect(initialized.organizationId).toBeTruthy()
      expect(initialized.adminUserId).toBeTruthy()

      const statusAfterInitialize = await caller.setup.getStatus()
      expect(statusAfterInitialize.stage).toBe("initialized")
      expect(statusAfterInitialize.hasSeedData).toBe(true)
      expect(statusAfterInitialize.isSetupComplete).toBe(false)

      const settings = await prisma.orgSettings.findUniqueOrThrow({
        where: { organizationId: initialized.organizationId },
        select: {
          companyName: true,
          companyEmail: true,
        },
      })

      expect(settings).toEqual({
        companyName: "Setup Billing",
        companyEmail: "billing-setup@example.com",
      })
    } else {
      await expect(caller.setup.initialize(setupInput)).rejects.toThrow()
    }

    const completed = await caller.setup.complete()
    expect(completed.stage).toBe("complete")
    expect(completed.isSetupComplete).toBe(true)

    await expect(caller.setup.complete()).rejects.toThrow()
    await expect(caller.setup.initialize(setupInput)).rejects.toThrow()
  })

  it("returns setup status shape", async () => {
    const status = await caller.setup.getStatus()
    expect(["new", "initialized", "complete"]).toContain(status.stage)
    expect(typeof status.isSetupComplete).toBe("boolean")
    expect(typeof status.hasSeedData).toBe("boolean")
  })
})
