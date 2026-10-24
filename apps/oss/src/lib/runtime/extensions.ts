import type { CompanyLookupService } from "./company-lookup"
export type { CompanyLookupService, CompanyLookupResult } from "./company-lookup"
export { assertOrganizationCvrAvailable, claimCvrTrial, isCvrTrialEligible } from "./cvr-admission"
import type { SellerVatConfirmationService } from "./seller-vat-confirmation"
export type { SellerVatConfirmationService, SellerVatConfirmationActor, SellerVatConfirmationTransaction } from "./seller-vat-confirmation"
import type { InvoiceIssuancePolicy, InvoiceIssuancePolicyContext } from "./invoice-issuance-policy"
export type { InvoiceIssuancePolicy, InvoiceIssuancePolicyContext } from "./invoice-issuance-policy"
import type {
  RuntimeCapabilities,
  RuntimeCapabilityPatch,
} from "@quits/contracts/runtime"
import { readBooleanEnv, readProductEnv } from "@quits/shared/runtimeEnv"
import { getEmailDeliveryRuntimeStatus } from "../email-delivery"
import { getRuntimeEnv, getRuntimePlatform } from "./platform"
import type { StripeCheckoutTarget, StripeCheckoutTargetContext } from "./stripe-checkout-target"
import type { Prisma } from "../../../generated/prisma/client"
export type { StripeCheckoutTarget, StripeCheckoutTargetContext } from "./stripe-checkout-target"

/** Released distributions can require the factual company lookup/review contract. */
export const COMPANY_LOOKUP_CONTRACT_VERSION = 1

/**
 * Verifies connected-account webhook events with one platform secret, then maps
 * `event.account` to the organization that owns that Stripe account.
 */
export type StripeConnectWebhookVerifier = {
  webhookSecret: string
  resolveOrganizationId: (stripeAccountId: string) => string | null | Promise<string | null>
}

/** Raw SQL only: an extension deletes its own tables, never the app's. */
export type OrganizationPurgeTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">
export type OrganizationPurgeContext = {
  organizationId: string
  /** Users deleted with the organization because it was their only membership. */
  userIds: readonly string[]
}

export type OrganizationDeletionRequest = {
  organizationId: string
  /** The admin who confirmed the deletion by typing the organization's name. */
  userId: string
}
/** `deleted`: the organization is gone now. `scheduled`: it will be deleted at `deleteAfter`. */
export type OrganizationDeletionOutcome = { status: "deleted" } | { status: "scheduled"; deleteAfter: Date }

export type RuntimeExtension = {
  id: string
  /** Hosted runtimes opt in after resolving existing duplicate CVRs. Ignored by self-host. */
  enforceCvrUniqueness?: boolean
  companyLookup?: CompanyLookupService
  sellerVatConfirmation?: SellerVatConfirmationService
  resolveInvoiceIssuancePolicy?: (context: InvoiceIssuancePolicyContext) => InvoiceIssuancePolicy | undefined | Promise<InvoiceIssuancePolicy | undefined>
  resolveCapabilities?: (
    baseCapabilities: Readonly<RuntimeCapabilities>
  ) => RuntimeCapabilityPatch | void
  /**
   * Hosted Connect checkout events. The first extension that returns a verifier
   * with a webhook secret is tried before per-organization BYOK secrets.
   * Self-hosted runtimes leave this unset.
   */
  resolveStripeConnectWebhook?: () =>
    | StripeConnectWebhookVerifier
    | undefined
    | Promise<StripeConnectWebhookVerifier | undefined>
  /**
   * Registers Connect card routing and disables BYOK fallback in this runtime.
   * Only active Connect targets may charge. Null and undefined mean unavailable.
   */
  resolveStripeCheckoutTarget?: (
    context: StripeCheckoutTargetContext
  ) => StripeCheckoutTarget | null | undefined | Promise<StripeCheckoutTarget | null | undefined>
  /**
   * Connect accounts that may still hold an open Checkout session, including one
   * the seller no longer charges. Self-hosted runtimes leave this unset.
   * A miss on one account is not expiry.
   */
  resolveStripeCheckoutExpiryTargets?: (
    context: StripeCheckoutTargetContext
  ) => readonly StripeCheckoutTarget[] | null | undefined | Promise<readonly StripeCheckoutTarget[] | null | undefined>
  /**
   * Runs inside the purge transaction, before the organization's rows and users are deleted, so a
   * distribution can delete its own rows that reference them. Throwing rolls the purge back.
   * Self-hosted runtimes leave this unset.
   */
  onOrganizationPurge?: (tx: OrganizationPurgeTransaction, context: OrganizationPurgeContext) => Promise<void>
  /**
   * Decides what "Delete organisation" in Settings does, after the app has checked that the user is
   * an admin and typed the organization's name. The first extension that sets this replaces the
   * self-hosted default, which purges at once. A scheduled deletion must still end in
   * `purgeOrganization`. Self-hosted runtimes leave this unset.
   */
  requestOrganizationDeletion?: (request: OrganizationDeletionRequest) => Promise<OrganizationDeletionOutcome>
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
    sellerVatConfirmation: { enabled: base.sellerVatConfirmation?.enabled ?? false, ...patch.sellerVatConfirmation },
    organizationDeletion: { enabled: base.organizationDeletion?.enabled ?? false, ...patch.organizationDeletion },
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
    onboardingV2: { ...base.onboardingV2, enabled: base.onboardingV2?.enabled ?? false, ...patch.onboardingV2 },
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
    onboardingV2: { enabled: false, nonVatEnabled: false },
    sellerVatConfirmation: { enabled: false },
    // Hosted turns it on once its extension decides what deletion does there.
    organizationDeletion: { enabled: !isCloud },
    documents: { artifactsRequired: true },
    agreements: { depositsEnabled: readBooleanEnv(readProductEnv(env, "DEPOSITS_ENABLED"), true) },
    aiInvoiceDraft: {
      enabled: byok || managed || localAgent,
      byok,
      managed,
      managedRequiresSubscription: managed,
      customEndpoint,
      localAgent,
      requestFallbackEnabled: readBooleanEnv(readProductEnv(env, "AI_REQUEST_FALLBACK_ENABLED"), false),
      requestDecisionsEnabled: Boolean(readProductEnv(env, "TYPESAFE_API_KEY")?.trim()),
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

  // V2 is opt-in for hosted deployments; self-hosted installations stay on manual setup.
  capabilities.onboardingV2 = {
    enabled: isHostedRuntime(env) && capabilities.onboardingV2?.enabled === true,
    nonVatEnabled: isHostedRuntime(env) && capabilities.onboardingV2?.nonVatEnabled === true,
  }
  capabilities.sellerVatConfirmation = { enabled: isHostedRuntime(env) && capabilities.sellerVatConfirmation?.enabled === true }
  // Issuance artifacts are a release invariant; runtime extensions cannot opt out.
  capabilities.documents.artifactsRequired = true
  // Report provider configuration, including managed runtimes, without exposing credentials.
  const { configured } = getEmailDeliveryRuntimeStatus({
    managed: capabilities.emailDelivery.managed,
    resendApiKey: env.RESEND_API_KEY,
    fromEmail: env.FROM_EMAIL,
    emailProvider: env.EMAIL_PROVIDER,
    smtp: env,
    runtimeKind: getRuntimePlatform().getRuntimeKind(),
  })
  return { ...capabilities, emailDelivery: { ...capabilities.emailDelivery, configured } }
}

function isHostedRuntime(env: Record<string, string | undefined>) {
  return readProductEnv(env, "DISTRIBUTION")?.trim().toLowerCase() === "cloud"
}

/** The hosted extension can opt in after it supports non-VAT onboarding. OSS remains configurable. */
export function isNonVatRegistrationAllowed() {
  return !isHostedRuntime(getRuntimeEnv()) || getRuntimeCapabilities().onboardingV2?.nonVatEnabled === true
}
