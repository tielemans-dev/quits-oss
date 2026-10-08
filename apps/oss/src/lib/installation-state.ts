import { isCloudDistribution } from "./distribution"
import { prisma } from "./db"

const INSTALLATION_STATE_ID = "default"
const DEFAULT_SETUP_VERSION = 1

export type InstallationStateRecord = {
  id: string
  isSetupComplete: boolean
  distribution: string
  setupVersion: number
  createdAt: Date
  updatedAt: Date
}

type InstallationStateCreateInput = Pick<
  InstallationStateRecord,
  "id" | "isSetupComplete" | "distribution" | "setupVersion"
>

export interface InstallationStateStore {
  findById(id: string): Promise<InstallationStateRecord | null>
  create(data: InstallationStateCreateInput): Promise<InstallationStateRecord>
  countOrganizations(): Promise<number>
  countMembers(): Promise<number>
}

const prismaInstallationStore: InstallationStateStore = {
  findById: (id) =>
    prisma.installationState.findUnique({
      where: { id },
    }),
  create: (data) =>
    prisma.installationState.create({
      data,
    }),
  countOrganizations: () => prisma.organization.count(),
  countMembers: () => prisma.member.count(),
}

function defaultDistribution() {
  return isCloudDistribution ? "cloud" : "selfhost"
}

async function inferSetupCompletion(store: InstallationStateStore) {
  const [organizationCount, memberCount] = await Promise.all([
    store.countOrganizations(),
    store.countMembers(),
  ])

  return organizationCount > 0 && memberCount > 0
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  )
}

type EnsureInstallationStateOptions = {
  store?: InstallationStateStore
  distribution?: string
  setupVersion?: number
}

export async function ensureInstallationState(
  options: EnsureInstallationStateOptions = {}
) {
  const store = options.store ?? prismaInstallationStore
  const setupVersion = options.setupVersion ?? DEFAULT_SETUP_VERSION
  const distribution = options.distribution ?? defaultDistribution()

  const existing = await store.findById(INSTALLATION_STATE_ID)
  if (existing) {
    return existing
  }

  const isSetupComplete = await inferSetupCompletion(store)

  try {
    return await store.create({
      id: INSTALLATION_STATE_ID,
      isSetupComplete,
      distribution,
      setupVersion,
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const concurrentState = await store.findById(INSTALLATION_STATE_ID)
      if (concurrentState) {
        return concurrentState
      }
    }
    throw error
  }
}

export type InstallationStatus = Pick<
  InstallationStateRecord,
  "isSetupComplete" | "distribution" | "setupVersion"
> & {
  /** Whether this deployment bills. Known to the server only; a browser build cannot tell. */
  billingEnabled: boolean
}
