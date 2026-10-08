import type { ClientActionCapability, ClientActionRecordKind } from "@quits/contracts/client-actions"
import { prisma } from "../db"
import { publicPresentationSettingsSelect, resolvePublicPresentation } from "../documents/public-presentation"
import { getClientActionSecret, verifyClientActionToken } from "./tokens"

/**
 * Whether a client action link opens anything, decided from its row on every request. Revoking or
 * expiring a link takes effect on the next call; nothing is cached in the token.
 */
export type ClientActionAccess =
  /** Not a link of ours: no seller to name, nothing to recover through. */
  | { status: "invalid" }
  /** A genuine link that no longer works. Names the seller so the visitor knows whom to ask. */
  | { status: "inactive"; reason: "expired" | "revoked"; seller: { name: string | null }; locale: string }
  | { status: "active"; link: ActiveClientActionLink }

const linkInclude = {
  grants: { orderBy: { createdAt: "asc" } },
  organization: { select: { settings: { select: publicPresentationSettingsSelect } } },
} as const

export async function loadClientActionLinkRow(id: string) {
  return prisma.clientActionLink.findUnique({ where: { id }, include: linkInclude })
}
export type ClientActionLinkRow = NonNullable<Awaited<ReturnType<typeof loadClientActionLinkRow>>>
export type ActiveClientActionLink = ClientActionLinkRow

/** The state of a link row at an instant. Revocation wins over expiry: it is the seller's act. */
export function clientActionLinkState(link: { revokedAt: Date | null; expiresAt: Date }, now: Date) {
  if (link.revokedAt) return "revoked" as const
  if (now >= link.expiresAt) return "expired" as const
  return "active" as const
}

export async function resolveClientActionAccess(
  token: string,
  now = new Date(),
  secret = getClientActionSecret(),
): Promise<ClientActionAccess> {
  const linkId = verifyClientActionToken(token, secret)
  if (!linkId) return { status: "invalid" }
  const link = await loadClientActionLinkRow(linkId)
  if (!link) return { status: "invalid" }
  const state = clientActionLinkState(link, now)
  if (state !== "active") {
    const presentation = resolvePublicPresentation({
      document: {},
      settings: link.organization.settings,
      logoPath: "",
    })
    return { status: "inactive", reason: state, seller: { name: presentation.seller.name }, locale: presentation.locale }
  }
  return { status: "active", link }
}

export type GrantRef = ActiveClientActionLink["grants"][number]

export function grantCapabilities(grant: Pick<GrantRef, "capabilities">): ClientActionCapability[] {
  return grant.capabilities.filter((value): value is ClientActionCapability =>
    value === "view" || value === "pay" || value === "approve",
  )
}

/**
 * The grant of a link for one record, or null. A request for any record the link was not granted
 * is the same as a request for a record that does not exist.
 */
export function findGrant(
  link: ActiveClientActionLink,
  kind: ClientActionRecordKind,
  recordId: string,
  capability: ClientActionCapability,
) {
  const grant = link.grants.find((current) => current.recordKind === kind && current.recordId === recordId)
  if (!grant || !grantCapabilities(grant).includes(capability)) return null
  return grant
}

/** Records the visitor opened the page: best effort, never blocks the page. */
export async function touchClientActionLink(id: string, now: Date) {
  await prisma.clientActionLink
    .updateMany({ where: { id, OR: [{ lastOpenedAt: null }, { lastOpenedAt: { lt: new Date(now.getTime() - 60_000) } }] }, data: { lastOpenedAt: now } })
    .catch(() => undefined)
}
