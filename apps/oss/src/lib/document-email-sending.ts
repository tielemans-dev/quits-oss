export type DocumentSendingDomainStatus =
  | "not_configured"
  | "pending_dns"
  | "verifying"
  | "verified"
  | "failed"

export type DocumentSendingDomainRecord = {
  name: string
  type: string
  value: string
  ttl?: number | null
  status?: string | null
}

export type DocumentSendingSyncSource = "manual" | "webhook"

export type DocumentSendingDomainState = {
  domain: string | null
  providerId: string | null
  status: DocumentSendingDomainStatus
  records: DocumentSendingDomainRecord[]
  failureReason: string | null
  verifiedAt: Date | null
}

export type DocumentSendingSyncState = {
  lastSyncedAt: Date | null
  lastSyncSource: DocumentSendingSyncSource | null
}

export type DocumentEmailEnvelope = {
  fromEmail: string
  fromName: string
  replyTo: string | null
  usingBrandedDomain: boolean
}

const DOMAIN_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

function normalizeEmailAddress(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ""
  return normalized.length > 0 ? normalized : null
}

function normalizeDomain(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/\.+$/, "") ?? ""
  return normalized.length > 0 ? normalized : null
}

function getLocalPart(email: string): string {
  const [localPart] = email.split("@")
  return localPart || "noreply"
}

export function readDocumentSendingDomainState(input: {
  documentSendingDomain?: string | null
  documentSendingDomainProviderId?: string | null
  documentSendingDomainStatus?: string | null
  documentSendingDomainRecords?: unknown
  documentSendingDomainFailureReason?: string | null
  documentSendingDomainVerifiedAt?: Date | null
}): DocumentSendingDomainState {
  return {
    domain: normalizeDomain(input.documentSendingDomain),
    providerId: input.documentSendingDomainProviderId?.trim() || null,
    status: toDocumentSendingDomainStatus(input.documentSendingDomainStatus),
    records: readDocumentSendingDomainRecords(input.documentSendingDomainRecords),
    failureReason: input.documentSendingDomainFailureReason?.trim() || null,
    verifiedAt: input.documentSendingDomainVerifiedAt ?? null,
  }
}

export function readDocumentSendingSyncState(input: {
  documentSendingLastSyncedAt?: Date | null
  documentSendingLastSyncSource?: string | null
}): DocumentSendingSyncState {
  return {
    lastSyncedAt: input.documentSendingLastSyncedAt ?? null,
    lastSyncSource: toDocumentSendingSyncSource(input.documentSendingLastSyncSource),
  }
}

export function createDocumentSendingSyncUpdate(input: {
  at?: Date
  source: DocumentSendingSyncSource
}) {
  return {
    documentSendingLastSyncedAt: input.at ?? new Date(),
    documentSendingLastSyncSource: input.source,
  }
}

export function resolveDocumentEmailEnvelope(input: {
  orgName?: string | null
  orgBillingEmail?: string | null
  sharedFromEmail: string
  branded?: {
    status?: DocumentSendingDomainStatus | null
    domain?: string | null
  } | null
}): DocumentEmailEnvelope {
  const orgName = input.orgName?.trim() || "Quits"
  const sharedFromEmail = normalizeEmailAddress(input.sharedFromEmail) ?? "noreply@yaip.app"
  const replyTo = normalizeEmailAddress(input.orgBillingEmail)
  const brandedDomain = normalizeDomain(input.branded?.domain)
  const brandedStatus = toDocumentSendingDomainStatus(input.branded?.status)

  if (brandedStatus === "verified" && brandedDomain) {
    return {
      fromEmail: `${getLocalPart(sharedFromEmail)}@${brandedDomain}`,
      fromName: orgName,
      replyTo,
      usingBrandedDomain: true,
    }
  }

  return {
    fromEmail: sharedFromEmail,
    fromName: `${orgName} via Quits`,
    replyTo,
    usingBrandedDomain: false,
  }
}

export function validateDocumentSendingDomain(value: string): 
  | { valid: true; normalizedDomain: string }
  | { valid: false; reason: string } {
  const normalizedDomain = normalizeDomain(value)

  if (!normalizedDomain) {
    return {
      valid: false,
      reason: "Document sending domain is required",
    }
  }

  const labels = normalizedDomain.split(".")

  if (labels.length < 3) {
    return {
      valid: false,
      reason: "Document sending domains must use a subdomain, not the root domain",
    }
  }

  if (labels.some((label) => !DOMAIN_LABEL_REGEX.test(label))) {
    return {
      valid: false,
      reason: "Document sending domain must be a valid hostname",
    }
  }

  return {
    valid: true,
    normalizedDomain,
  }
}

function toDocumentSendingDomainStatus(
  value: string | DocumentSendingDomainStatus | null | undefined
): DocumentSendingDomainStatus {
  switch (value) {
    case "pending_dns":
    case "verifying":
    case "verified":
    case "failed":
      return value
    default:
      return "not_configured"
  }
}

function toDocumentSendingSyncSource(
  value: string | DocumentSendingSyncSource | null | undefined
): DocumentSendingSyncSource | null {
  switch (value) {
    case "manual":
    case "webhook":
      return value
    default:
      return null
  }
}

function readDocumentSendingDomainRecords(value: unknown): DocumentSendingDomainRecord[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return []
    }

    const record = entry as Record<string, unknown>
    const name = typeof record.name === "string" ? record.name.trim() : ""
    const type = typeof record.type === "string" ? record.type.trim() : ""
    const rawValue = typeof record.value === "string" ? record.value.trim() : ""

    if (!name || !type || !rawValue) {
      return []
    }

    return [
      {
        name,
        type,
        value: rawValue,
        ttl: typeof record.ttl === "number" ? record.ttl : null,
        status: typeof record.status === "string" ? record.status : null,
      },
    ]
  })
}
