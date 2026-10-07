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
  renderUbl?(input: RenderInput): Promise<Uint8Array>
  version: string
}
export type DocumentArtifactStore = {
  put(bytes: Uint8Array, meta: ArtifactMeta): Promise<ArtifactRef>
  get(ref: ArtifactRef): Promise<Uint8Array | null>
  head(ref: ArtifactRef): Promise<ArtifactMeta | null>
  delete(ref: ArtifactRef): Promise<void>
}

export type RuntimeServices = {
  documentRenderer?: DocumentRenderer
  documentArtifactStore?: DocumentArtifactStore
  billingProvider: BillingProvider
  onboardingAiService: OnboardingAiService
  managedDocumentDomainProvider: ManagedDocumentDomainProvider
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
}

export function resetRuntimeServices() {
  runtimeServices = { ...defaultServices }
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
export function getDocumentArtifactStore() { return runtimeServices.documentArtifactStore }
