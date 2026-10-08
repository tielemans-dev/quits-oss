import { useRouterState } from "@tanstack/react-router"
import { billingEnabled as buildBillingEnabled, isCloudDistribution } from "./distribution"

export type Distribution = "cloud" | "selfhost"

/**
 * What the running server says about its own deployment. The server knows it from its runtime
 * environment; a browser has no `process` and usually no build-time variable, so the server hands
 * the value over in the route context instead (see `getAppLayoutSession`, and the root route's
 * `installation` for routes outside the app layout).
 */
export type RuntimeDistribution = {
  distribution: Distribution
  billingEnabled: boolean
}

export type ResolvedDistribution = RuntimeDistribution & {
  isCloud: boolean
  isSelfHost: boolean
}

/** The distribution of this process, from its runtime environment. Server only. */
export function readRuntimeDistribution(): RuntimeDistribution {
  return {
    distribution: isCloudDistribution ? "cloud" : "selfhost",
    billingEnabled: buildBillingEnabled,
  }
}

type DistributionContext = {
  runtime?: Partial<RuntimeDistribution> | null
  installation?: { distribution?: string | null; billingEnabled?: boolean | null } | null
} | null | undefined

function normalizeDistribution(value: string | null | undefined): Distribution | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "cloud" || normalized === "selfhost") return normalized
  return undefined
}

/**
 * Resolves the distribution from route context: the value the server delivered wins; the
 * build-time constants (`VITE_QUITS_DISTRIBUTION`, or the runtime environment on the server) only
 * fill in when no route has delivered one. Both agree whenever the build variable is set.
 */
export function resolveRuntimeDistribution(context: DistributionContext): ResolvedDistribution {
  const distribution =
    normalizeDistribution(context?.runtime?.distribution) ??
    normalizeDistribution(context?.installation?.distribution) ??
    (isCloudDistribution ? "cloud" : "selfhost")
  // Outside the app layout only the root's `installation` is in context; it carries the server's
  // billing answer too, so the build-time constant (always false in a browser) is a last resort.
  const billingEnabled =
    context?.runtime?.billingEnabled ??
    context?.installation?.billingEnabled ??
    (distribution === "cloud" && buildBillingEnabled)

  return {
    distribution,
    billingEnabled,
    isCloud: distribution === "cloud",
    isSelfHost: distribution !== "cloud",
  }
}

/**
 * The distribution as the server reports it, for components. Reads the deepest matched route's
 * context, which merges every parent's, so it is available on the server render, while hydrating
 * and on later client navigations alike.
 */
export function useRuntimeDistribution(): ResolvedDistribution {
  const context = useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.context,
  }) as DistributionContext
  return resolveRuntimeDistribution(context)
}
