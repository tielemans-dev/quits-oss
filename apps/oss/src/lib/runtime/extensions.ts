import type { InvoiceIssuancePolicy, InvoiceIssuancePolicyContext } from "./invoice-issuance-policy"
export type { InvoiceIssuancePolicy, InvoiceIssuancePolicyContext } from "./invoice-issuance-policy"
import type {
  RuntimeCapabilities,
  RuntimeCapabilityPatch,
} from "@quits/contracts/runtime"
import { readBooleanEnv, readProductEnv } from "@quits/shared/runtimeEnv"
import { getRuntimeEnv, getRuntimePlatform } from "./platform"

export type RuntimeExtension = {
  id: string
  resolveInvoiceIssuancePolicy?: (context: InvoiceIssuancePolicyContext) => InvoiceIssuancePolicy | undefined | Promise<InvoiceIssuancePolicy | undefined>
  resolveCapabilities?: (
    baseCapabilities: Readonly<RuntimeCapabilities>
  ) => RuntimeCapabilityPatch | void
}

const DEFAULT_MAX_PROMPT_CHARS = 4000
let runtimeExtensions: RuntimeExtension[] = []

function mergeCapabilities(
  base: RuntimeCapabilities,
  patch: RuntimeCapabilityPatch | void
): RuntimeCapabilities {
  if (!patch) {
    return base
  }

  return {
    documents: { ...base.documents, ...patch.documents },
    agreements: { ...base.agreements, ...patch.agreements },
    aiInvoiceDraft: {
      ...base.aiInvoiceDraft,
      ...patch.aiInvoiceDraft,
    },
    onboardingAi: {
      ...base.onboardingAi,
      ...patch.onboardingAi,
    },
    payments: {
      ...base.payments,
      ...patch.payments,
    },
    emailDelivery: {
      ...base.emailDelivery,
      ...patch.emailDelivery,
    },
  }
}

function readDefaultCapabilities(
  env: Record<string, string | undefined>
): RuntimeCapabilities {
  const distribution = readProductEnv(env, "DISTRIBUTION")?.trim().toLowerCase()
  const isCloud = distribution === "cloud"
  const byok = readBooleanEnv(readProductEnv(env, "AI_BYOK_ENABLED"), true)
  const managed = readBooleanEnv(readProductEnv(env, "AI_MANAGED_ENABLED"), false)
  const customEndpoint = readBooleanEnv(
    readProductEnv(env, "AI_CUSTOM_ENDPOINT_ENABLED"),
    !isCloud
  )
  // Running a local agent is an operator decision: it needs both the flag and a command.
  const localAgent =
    !isCloud &&
    getRuntimePlatform().getRuntimeKind() === "node" &&
    readBooleanEnv(readProductEnv(env, "AI_LOCAL_AGENT_ENABLED"), false) &&
    Boolean(readProductEnv(env, "AI_LOCAL_AGENT_COMMAND")?.trim())
  const onboardingAiManaged = readBooleanEnv(
    readProductEnv(env, "ONBOARDING_AI_MANAGED_ENABLED"),
    isCloud
  )
  const onboardingAiEnabled = readBooleanEnv(
    readProductEnv(env, "ONBOARDING_AI_ENABLED"),
    onboardingAiManaged
  )

  return {
    documents: { artifactsRequired: true },
    agreements: { depositsEnabled: readBooleanEnv(readProductEnv(env, "DEPOSITS_ENABLED"), true) },
    aiInvoiceDraft: {
      enabled: byok || managed || localAgent,
      byok,
      managed,
      managedRequiresSubscription: managed,
      customEndpoint,
      localAgent,
      maxPromptChars: DEFAULT_MAX_PROMPT_CHARS,
    },
    onboardingAi: {
      enabled: onboardingAiEnabled,
      managed: onboardingAiManaged,
    },
    payments: {
      enabled: false,
      managed: false,
      provider: null,
    },
    emailDelivery: {
      enabled: true,
      managed: false,
    },
  }
}

function uniqueExtensions(extensions: RuntimeExtension[]) {
  const seen = new Set<string>()
  const unique: RuntimeExtension[] = []

  for (const extension of extensions) {
    if (!extension.id || seen.has(extension.id)) {
      continue
    }
    seen.add(extension.id)
    unique.push(extension)
  }

  return unique
}

export function setRuntimeExtensions(extensions: RuntimeExtension[]) {
  runtimeExtensions = uniqueExtensions(extensions)
}

export function getRuntimeExtensions() {
  return [...runtimeExtensions]
}

export function getRuntimeCapabilities(
  env: Record<string, string | undefined> = getRuntimeEnv()
) {
  let capabilities = readDefaultCapabilities(env)

  // The last extension that sets `enabled` explicitly decides whether it may be on.
  let enabledByExtension: boolean | undefined
  for (const extension of runtimeExtensions) {
    const patch = extension.resolveCapabilities?.(capabilities)
    if (patch && patch.aiInvoiceDraft?.enabled !== undefined) {
      enabledByExtension = patch.aiInvoiceDraft.enabled
    }
    capabilities = mergeCapabilities(capabilities, patch)
  }

  // `enabled` follows the provider flags after extensions patch them, so an extension that turns on
  // managed AI also enables drafting. An extension can still switch drafting off explicitly.
  const ai = capabilities.aiInvoiceDraft
  ai.enabled = enabledByExtension !== false && (ai.byok || ai.managed || ai.localAgent)

  // Issuance artifacts are a release invariant; runtime extensions cannot opt out.
  capabilities.documents.artifactsRequired = true
  return capabilities
}
