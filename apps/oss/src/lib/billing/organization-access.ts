import { TRPCError } from "@trpc/server"
import type { OrganizationAccess } from "./types"
export type { OrganizationAccess } from "./types"

/** The same server decision supplies UI state and authorizes mutations. Missing state fails closed. */
export function assertOrganizationWriteAccess(access: OrganizationAccess | undefined) {
  if (!access || !["self_hosted", "subscribed", "complimentary", "trial"].includes(access.state)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Organization is read-only. Open billing to recover access." })
  }
}
