import { createServerFn } from "@tanstack/react-start"
import type { InstallationStatus } from "./installation-state"
import { billingEnabled, isCloudDistribution } from "./distribution"

const DEFAULT_SETUP_VERSION = 1

export function normalizeInstallationStatus(
  status: Partial<InstallationStatus> | null | undefined
): InstallationStatus {
  const distribution = isCloudDistribution ? "cloud" : "selfhost"

  return {
    isSetupComplete: status?.isSetupComplete ?? false,
    distribution: status?.distribution ?? distribution,
    setupVersion: status?.setupVersion ?? DEFAULT_SETUP_VERSION,
    billingEnabled: status?.billingEnabled ?? (distribution === "cloud" && billingEnabled),
  }
}

export const getInstallationStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<InstallationStatus> => {
    const { ensureInstallationState } = await import("./installation-state")
    const state = await ensureInstallationState()

    // In hosted cloud mode, setup state is org-scoped rather than installation-scoped.
    return normalizeInstallationStatus({
      isSetupComplete: state.isSetupComplete,
      distribution: isCloudDistribution ? "cloud" : "selfhost",
      setupVersion: state.setupVersion,
      billingEnabled,
    })
  }
)
