import { resolveCountryProfile } from "../compliance"
import { requireCurrencyExponent } from "@quits/shared/currency"
import { randomUUID } from "node:crypto"
import { hashPassword } from "better-auth/crypto"
import { prisma } from "../db"
import { ensureInstallationState } from "../installation-state"
import type { SetupInitializeInput } from "./validators"

const INSTALLATION_STATE_ID = "default"
const CREDENTIAL_PROVIDER_ID = "credential"

export type SetupStage = "new" | "initialized" | "complete"

export type SetupStatus = {
  isSetupComplete: boolean
  distribution: string
  setupVersion: number
  hasSeedData: boolean
  stage: SetupStage
  organizationId: string | null
  adminUserId: string | null
}

export type SetupInitializationResult = SetupStatus & {
  organizationId: string
  adminUserId: string
}

export class SetupFlowError extends Error {
  constructor(
    readonly code:
      | "SETUP_ALREADY_COMPLETE"
      | "SETUP_ALREADY_INITIALIZED"
      | "SETUP_NOT_INITIALIZED"
      | "ADMIN_EMAIL_IN_USE"
      | "ORG_SLUG_IN_USE",
    message: string
  ) {
    super(message)
    this.name = "SetupFlowError"
  }
}

function buildOrganizationMetadata(input: SetupInitializeInput) {
  return JSON.stringify({
    setup: {
      instanceProfile: input.instanceProfile,
      authMode: input.auth.mode,
      initializedAt: new Date().toISOString(),
    },
  })
}

async function getSeedDataState() {
  const [organizationCount, userCount, memberCount, firstMember] = await Promise.all([
    prisma.organization.count(),
    prisma.user.count(),
    prisma.member.count(),
    prisma.member.findFirst({
      orderBy: { createdAt: "asc" },
      select: {
        organizationId: true,
        userId: true,
      },
    }),
  ])

  const hasSeedData = organizationCount > 0 && userCount > 0 && memberCount > 0

  return {
    hasSeedData,
    organizationId: firstMember?.organizationId ?? null,
    adminUserId: firstMember?.userId ?? null,
  }
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const state = await ensureInstallationState()
  const seedDataState = await getSeedDataState()

  const stage: SetupStage = state.isSetupComplete
    ? "complete"
    : seedDataState.hasSeedData
      ? "initialized"
      : "new"

  return {
    isSetupComplete: state.isSetupComplete,
    distribution: state.distribution,
    setupVersion: state.setupVersion,
    hasSeedData: seedDataState.hasSeedData,
    stage,
    organizationId: seedDataState.organizationId,
    adminUserId: seedDataState.adminUserId,
  }
}

export async function applySetupInitialization(
  input: SetupInitializeInput
): Promise<SetupInitializationResult> {
  const status = await getSetupStatus()
  if (status.isSetupComplete) {
    throw new SetupFlowError(
      "SETUP_ALREADY_COMPLETE",
      "Setup has already been completed for this installation"
    )
  }
  if (status.hasSeedData) {
    throw new SetupFlowError(
      "SETUP_ALREADY_INITIALIZED",
      "Setup has already been initialized for this installation"
    )
  }

  requireCurrencyExponent(input.locale.currency)
  const profile = resolveCountryProfile(input.locale.countryCode)
  // An unsupported country has no default currency; the currency chosen at setup stands in.
  const baseCurrency = profile.country?.defaults.currency ?? input.locale.currency
  const taxRegime = profile.regime?.id ?? "custom"

  const now = new Date()
  const adminEmail = input.admin.email.toLowerCase()
  const passwordHash = await hashPassword(input.admin.password)
  const organizationMetadata = buildOrganizationMetadata(input)
  const companyName = input.email?.fromName?.trim() || input.organization.name
  const companyEmail = input.email?.replyTo?.trim().toLowerCase() || adminEmail

  const created = await prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findUnique({
      where: { email: adminEmail },
      select: { id: true },
    })
    if (existingUser) {
      throw new SetupFlowError("ADMIN_EMAIL_IN_USE", "Admin email is already in use")
    }

    const existingOrganization = await tx.organization.findUnique({
      where: { slug: input.organization.slug },
      select: { id: true },
    })
    if (existingOrganization) {
      throw new SetupFlowError("ORG_SLUG_IN_USE", "Organization slug is already in use")
    }

    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        name: input.admin.name,
        email: adminEmail,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    })

    await tx.account.create({
      data: {
        id: randomUUID(),
        accountId: user.id,
        providerId: CREDENTIAL_PROVIDER_ID,
        userId: user.id,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      },
    })

    const organization = await tx.organization.create({
      data: {
        id: randomUUID(),
        name: input.organization.name,
        slug: input.organization.slug,
        metadata: organizationMetadata,
        createdAt: now,
        subscriptionStatus: "free",
      },
    })

    await tx.member.create({
      data: {
        id: randomUUID(),
        organizationId: organization.id,
        userId: user.id,
        role: "admin",
        createdAt: now,
      },
    })

    await tx.orgSettings.upsert({
      where: { organizationId: organization.id },
      update: {
        locale: input.locale.locale,
        countryCode: input.locale.countryCode,
        timezone: input.locale.timezone,
        defaultCurrency: input.locale.currency,
        baseCurrency,
        taxRegime,
        currency: input.locale.currency,
        companyName,
        companyEmail,
      },
      create: {
        organizationId: organization.id,
        locale: input.locale.locale,
        countryCode: input.locale.countryCode,
        timezone: input.locale.timezone,
        defaultCurrency: input.locale.currency,
        baseCurrency,
        taxRegime,
        currency: input.locale.currency,
        companyName,
        companyEmail,
      },
    })

    await tx.installationState.upsert({
      where: { id: INSTALLATION_STATE_ID },
      update: {
        isSetupComplete: false,
      },
      create: {
        id: INSTALLATION_STATE_ID,
        isSetupComplete: false,
        distribution: status.distribution,
        setupVersion: status.setupVersion,
      },
    })

    return {
      organizationId: organization.id,
      adminUserId: user.id,
    }
  })

  return {
    ...(await getSetupStatus()),
    stage: "initialized",
    isSetupComplete: false,
    hasSeedData: true,
    organizationId: created.organizationId,
    adminUserId: created.adminUserId,
  }
}

export async function completeSetup(): Promise<SetupStatus> {
  const status = await getSetupStatus()
  if (status.isSetupComplete) {
    throw new SetupFlowError(
      "SETUP_ALREADY_COMPLETE",
      "Setup has already been completed for this installation"
    )
  }

  if (!status.hasSeedData || !status.organizationId || !status.adminUserId) {
    throw new SetupFlowError(
      "SETUP_NOT_INITIALIZED",
      "Setup must be initialized before completion"
    )
  }

  await ensureInstallationState()
  await prisma.installationState.update({
    where: { id: INSTALLATION_STATE_ID },
    data: { isSetupComplete: true },
  })

  return {
    ...(await getSetupStatus()),
    stage: "complete",
    isSetupComplete: true,
  }
}
