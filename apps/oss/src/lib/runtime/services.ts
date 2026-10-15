import type { CvrCompany, OnboardingSuggestions } from "@quits/contracts/cvr"
import type { AiProvider } from "../ai/provider"
import type { AccountingDeliveryRuntime } from "../../domain/accounting/connections"
import { setOperationPolicy, type OperationPolicy } from "./operation-policy"
export type { OperationPolicy, RuntimeOperation, OperationDecision } from "./operation-policy"
import type { RenderInput } from "../../domain/documents/render-input"
export type { RenderInput } from "../../domain/documents/render-input"

import type {
  OnboardingAiSuggestion,
  OnboardingMissingField,
  OnboardingPatch,
} from "@quits/contracts/onboarding"
import { NoopBillingProvider } from "../billing/noop-provider"
import type { BillingProvider } from "../billing/types"
import type { DocumentSendingDomainRecord, DocumentSendingDomainStatus } from "../document-email-sending"
import { suggestOnboardingPatchHeuristically } from "../onboarding/ai-fallback"
import type { StripeConnectSettingsHandler } from "./stripe-connect-settings"

export type { CvrLookupCompany } from "../onboarding/search-cvr"
export type { StripeConnectSettingsAction, StripeConnectSettingsHandler } from "./stripe-connect-settings"

export type OnboardingAiSuggestInput = {
  userMessage: string
  currentValues: Partial<OnboardingPatch>
  missing: readonly OnboardingMissingField[]
}

export type OnboardingAiService = {
  suggestPatch: (input: OnboardingAiSuggestInput) => Promise<OnboardingAiSuggestion>
}

export type ManagedDocumentDomainResult = {
  providerId: string
  domain: string
  status: Exclude<DocumentSendingDomainStatus, "not_configured">
  records: DocumentSendingDomainRecord[]
  failureReason: string | null
  verifiedAt: Date | null
}

export type ManagedDocumentDomainProvider = {
  supported: boolean
  createDomain: (input: { domain: string }) => Promise<ManagedDocumentDomainResult>
  refreshDomain: (input: { providerId: string; domain: string }) => Promise<ManagedDocumentDomainResult>
  deleteDomain: (input: { providerId: string; domain: string }) => Promise<void>
}

export type ArtifactRef = string
export type ArtifactMeta = {
  organizationId: string
  documentKind: RenderInput["kind"]
  documentId: string
  format: "pdf" | "ubl"
  hash: string
  size: number
  rendererVersion: string
}
export type DocumentRenderer = {
  renderPdf(input: RenderInput): Promise<Uint8Array>
  renderUbl?(input: RenderInput): Promise<Uint8Array | null>
  version: string
}
export type DocumentArtifactStore = {
  put(bytes: Uint8Array, meta: ArtifactMeta): Promise<ArtifactRef>
  get(ref: ArtifactRef): Promise<Uint8Array | null>
  head(ref: ArtifactRef): Promise<ArtifactMeta | null>
  delete(ref: ArtifactRef): Promise<void>
}

/** Cloud supplies a server-side registry proxy. Self-host has no lookup provider. */
export type CvrLookupProvider = {
  search(query: string, context: CvrLookupContext): Promise<CvrCompany[]>
  get(cvr: string, context: CvrLookupContext): Promise<CvrCompany | null>
  suggestions?(cvr: string, context: CvrLookupContext): Promise<OnboardingSuggestions>
  /** Optional public company text, collected by a trusted adapter. Never fetch user-supplied URLs. */
  researchSources?(cvr: string, context: CvrLookupContext): Promise<Array<{ url: string; text: string }>>
}
export type CvrLookupContext = { userId: string; organizationId?: string; signal: AbortSignal }

export type RuntimeServices = {
  /** Optional in every distribution until transport/reconciliation and frozen settings are supplied. */
  accountingDelivery?: AccountingDeliveryRuntime
  cvrLookupProvider?: CvrLookupProvider
  operationPolicy?: OperationPolicy
  documentRenderer?: DocumentRenderer
  documentArtifactStore?: DocumentArtifactStore
  billingProvider: BillingProvider
  onboardingAiService: OnboardingAiService
  managedDocumentDomainProvider: ManagedDocumentDomainProvider
  /** Hosted AI provider, billed by the distribution. Absent in self-hosted installs. */
  managedAiProvider?: AiProvider
  /**
   * Hosted Stripe Connect actions for settings. While this is absent, those settings
   * actions stay disabled.
   */
  stripeConnectSettings?: StripeConnectSettingsHandler
}

const unsupportedManagedDocumentDomains = async (): Promise<never> => {
  throw new Error("Managed document domains are not available")
}

const defaultServices: RuntimeServices = {
  billingProvider: new NoopBillingProvider(),
  onboardingAiService: {
    suggestPatch: async (input) => suggestOnboardingPatchHeuristically(input),
  },
  managedDocumentDomainProvider: {
    supported: false,
    createDomain: unsupportedManagedDocumentDomains,
    refreshDomain: unsupportedManagedDocumentDomains,
    deleteDomain: unsupportedManagedDocumentDomains,
  },
}

let runtimeServices: RuntimeServices = { ...defaultServices }

export function setRuntimeServices(overrides: Partial<RuntimeServices>) {
  runtimeServices = {
    ...runtimeServices,
    ...overrides,
  }
  setOperationPolicy(runtimeServices.operationPolicy)
}

export function resetRuntimeServices() {
  runtimeServices = { ...defaultServices }
  setOperationPolicy(undefined)
}

export function getBillingProvider(): BillingProvider {
  return runtimeServices.billingProvider
}

export function getOnboardingAiService(): OnboardingAiService {
  return runtimeServices.onboardingAiService
}

export function getManagedDocumentDomainProvider(): ManagedDocumentDomainProvider {
  return runtimeServices.managedDocumentDomainProvider
}

export function getDocumentRenderer() { return runtimeServices.documentRenderer }
export function getAccountingDelivery() { return runtimeServices.accountingDelivery }
export function getDocumentArtifactStore() { return runtimeServices.documentArtifactStore }

export function getManagedAiProvider(): AiProvider | undefined {
  return runtimeServices.managedAiProvider
}

export function getCvrLookupProvider() { return runtimeServices.cvrLookupProvider }

export function getStripeConnectSettingsHandler(): StripeConnectSettingsHandler | undefined {
  return runtimeServices.stripeConnectSettings
}
