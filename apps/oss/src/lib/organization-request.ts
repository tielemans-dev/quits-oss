/**
 * The contract between the browser and the server for "which organization was this request made
 * for". Shared by the tRPC client and server, so it must stay free of browser- or server-only code.
 */

/**
 * Header the tRPC client sends with the organization the tab acts for. The server only compares
 * it with the session's active organization to reject requests made for another organization than
 * the one now active; it is never used for authorization.
 */
export const ORGANIZATION_HEADER = "x-quits-organization-id"
/** Sent by pages loaded before the product was renamed; read the same way. */
export const LEGACY_ORGANIZATION_HEADER = "x-yaip-organization-id"

/**
 * Header value for a batch of requests made for different organizations. The server always
 * rejects it, so no part of such a batch is applied to whichever organization is active by then.
 */
export const MIXED_ORGANIZATIONS = "mixed"

/** Message of the error the server answers a request for another organization with. */
export const ORGANIZATION_CHANGED_MESSAGE = "The active organization changed; reload and try again"

/**
 * Value of `data.reason` in the tRPC error shape when a request was rejected because it was made
 * for another organization than the session's active one. Lets the client tell this `CONFLICT`
 * apart from every other one.
 */
export const ORGANIZATION_CHANGED_REASON = "organization_changed"

/** Cause of the server error for a request made for another organization. */
export class OrganizationChangedError extends Error {
  constructor() {
    super(ORGANIZATION_CHANGED_MESSAGE)
    this.name = "OrganizationChangedError"
  }
}

/**
 * Whether the server rejected a request because the session's active organization is no longer
 * the one the tab acts for. Accepts any thrown value (a tRPC client error carries the error shape's
 * `data`).
 */
export function isOrganizationChangedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const data = (error as { data?: unknown }).data
  if (typeof data !== "object" || data === null) return false
  const { code, reason } = data as { code?: unknown; reason?: unknown }
  return code === "CONFLICT" && reason === ORGANIZATION_CHANGED_REASON
}

/**
 * Headers for tRPC requests made for the given organizations (`null` for unknown). Requests for
 * one organization carry it; requests for several carry `MIXED_ORGANIZATIONS`.
 */
export function organizationRequestHeaders(organizationIds: ReadonlyArray<string | null>): Record<string, string> {
  const known = new Set(organizationIds.filter((id): id is string => Boolean(id)))
  if (known.size === 0) return {}
  if (known.size > 1) return { [ORGANIZATION_HEADER]: MIXED_ORGANIZATIONS }
  return { [ORGANIZATION_HEADER]: [...known][0] }
}
