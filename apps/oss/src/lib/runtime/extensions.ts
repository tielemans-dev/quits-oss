import type {
  RuntimeCapabilities,
  RuntimeCapabilityPatch,
} from "@quits/contracts/runtime"
import { readBooleanEnv, readProductEnv } from "@quits/shared/runtimeEnv"
import { getRuntimeEnv } from "./platform"

export type RuntimeExtension = {
  id: string
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
    aiInvoiceDraft: {
      enabled: byok || managed,
      byok,
      managed,
      managedRequiresSubscription: managed,
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

  for (const extension of runtimeExtensions) {
    capabilities = mergeCapabilities(
      capabilities,
      extension.resolveCapabilities?.(capabilities)
    )
  }

  // Issuance artifacts are a release invariant; runtime extensions cannot opt out.
  capabilities.documents.artifactsRequired = true
  return capabilities
}
