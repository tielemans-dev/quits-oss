import { getRuntimeExtensions, type OrganizationDeletionOutcome, type OrganizationDeletionRequest } from "../lib/runtime/extensions"
import { purgeOrganization } from "./organization-purge"

/**
 * Carries out "Delete organisation" once the caller has checked the admin and the typed name. A
 * distribution's `requestOrganizationDeletion` decides what happens; without one the organization is
 * purged now.
 */
export async function requestOrganizationDeletion(request: OrganizationDeletionRequest): Promise<OrganizationDeletionOutcome> {
  const extension = getRuntimeExtensions().find(candidate => candidate.requestOrganizationDeletion)
  if (extension?.requestOrganizationDeletion) return extension.requestOrganizationDeletion(request)
  await purgeOrganization(request.organizationId)
  return { status: "deleted" }
}
