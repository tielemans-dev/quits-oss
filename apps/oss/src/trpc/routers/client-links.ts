import { TRPCError } from "@trpc/server"
import { Prisma } from "../../../generated/prisma/client"
import {
  clientActionLinkCreateInputSchema,
  clientActionLinkIdInputSchema,
  clientActionLinkRenewInputSchema,
  clientActionListInputSchema,
} from "@quits/contracts/client-actions"
import { createClientLink, renewClientLink, revokeClientLink } from "../../domain/commands/client-links"
import { executeCommand } from "../../domain/execute"
import { clientActionLinkState, grantCapabilities, loadClientActionLinkRow } from "../../lib/client-actions/access"
import { buildClientActionPage } from "../../lib/client-actions/page"
import { clientActionLinkUrl } from "../../lib/client-actions/tokens"
import { prisma } from "../../lib/db"
import { authorizedProcedure, router } from "../init"
import { unwrapOutcome } from "../outcome"

const GRANTABLE_LIMIT = 100

/** The seller's view of one link: its state, address and what it holds, labelled by record. */
async function describeLinks(organizationId: string, contactId: string) {
  const links = await prisma.clientActionLink.findMany({
    where: { organizationId, contactId },
    include: { grants: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
  })
  const ids = (kind: string) => links.flatMap((link) => link.grants.filter((g) => g.recordKind === kind).map((g) => g.recordId))
  const [agreements, deliverables, invoices] = await Promise.all([
    prisma.agreement.findMany({
      where: { id: { in: ids("agreement") }, organizationId, contactId },
      select: { id: true, number: true, title: true, publicAccessKeyVersion: true },
    }),
    prisma.deliverable.findMany({
      where: { id: { in: ids("deliverable") }, agreement: { organizationId, contactId } },
      select: { id: true, title: true, agreement: { select: { number: true, publicAccessKeyVersion: true } } },
    }),
    prisma.invoice.findMany({
      where: { id: { in: ids("invoice") }, organizationId, contactId },
      select: { id: true, number: true, publicPaymentKeyVersion: true },
    }),
  ])
  const now = new Date()
  return links.map((link) => ({
    id: link.id,
    url: clientActionLinkUrl(link.id),
    recipientName: link.recipientName,
    recipientEmail: link.recipientEmail,
    verification: link.verification,
    state: clientActionLinkState(link, now),
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    lastOpenedAt: link.lastOpenedAt,
    createdAt: link.createdAt,
    createdBy: link.createdBy,
    grants: link.grants.map((grant) => {
      const agreement = agreements.find((a) => a.id === grant.recordId)
      const line = deliverables.find((d) => d.id === grant.recordId)
      const invoice = invoices.find((i) => i.id === grant.recordId)
      const label =
        grant.recordKind === "agreement" ? [agreement?.number, agreement?.title].filter(Boolean).join(" ")
        : grant.recordKind === "deliverable" ? [line?.agreement.number, line?.title].filter(Boolean).join(" · ")
        : (invoice?.number ?? "")
      const currentVersion =
        grant.recordKind === "agreement" ? agreement?.publicAccessKeyVersion
        : grant.recordKind === "deliverable" ? line?.agreement.publicAccessKeyVersion
        : invoice?.publicPaymentKeyVersion
      return {
        id: grant.id,
        kind: grant.recordKind as "agreement" | "deliverable" | "invoice",
        recordId: grant.recordId,
        label,
        capabilities: grantCapabilities(grant),
        /** The seller re-issued or revoked the record's links after this grant was made. */
        stale: currentVersion !== undefined && currentVersion !== grant.keyVersion,
      }
    }),
  }))
}

export const clientLinksRouter = router({
  list: authorizedProcedure("clientLink:read")
    .input(clientActionListInputSchema)
    .query(({ ctx, input }) => describeLinks(ctx.organizationId, input.contactId)),

  /** Records of one contact that can be put on a client action page. */
  candidates: authorizedProcedure("clientLink:read")
    .input(clientActionListInputSchema)
    .query(async ({ ctx, input }) => {
      const scope = { organizationId: ctx.organizationId, contactId: input.contactId }
      const [agreements, deliverables, invoices] = await Promise.all([
        prisma.agreement.findMany({
          where: { ...scope, offerSnapshot: { not: Prisma.DbNull }, status: { not: "draft" } },
          select: { id: true, number: true, title: true, status: true },
          orderBy: { createdAt: "desc" },
          take: GRANTABLE_LIMIT,
        }),
        prisma.deliverable.findMany({
          where: {
            isDeposit: false,
            status: { in: ["delivered", "accepted", "changes_requested"] },
            agreement: { ...scope, status: "accepted", offerSnapshot: { not: Prisma.DbNull } },
          },
          select: { id: true, title: true, status: true, deliveryRevision: true, agreement: { select: { number: true } } },
          orderBy: [{ agreement: { createdAt: "desc" } }, { sortOrder: "asc" }],
          take: GRANTABLE_LIMIT,
        }),
        prisma.invoice.findMany({
          where: { ...scope, publicPaymentIssuedAt: { not: null }, status: { in: ["sent", "overdue", "paid", "credited"] } },
          select: { id: true, number: true, status: true, totalGross: true, currency: true },
          orderBy: { createdAt: "desc" },
          take: GRANTABLE_LIMIT,
        }),
      ])
      return {
        agreements,
        deliverables: deliverables.map((line) => ({
          id: line.id,
          title: line.title,
          status: line.status,
          deliveryRevision: line.deliveryRevision,
          agreementNumber: line.agreement.number,
        })),
        invoices: invoices.map((invoice) => ({ ...invoice, totalGross: invoice.totalGross.toNumber() })),
      }
    }),

  create: authorizedProcedure("clientLink:create")
    .input(clientActionLinkCreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      const link = unwrapOutcome(await executeCommand(createClientLink, input, { actor: ctx.actor }))
      return { id: link.id, url: clientActionLinkUrl(link.id) }
    }),

  revoke: authorizedProcedure("clientLink:revoke")
    .input(clientActionLinkIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      const link = unwrapOutcome(await executeCommand(revokeClientLink, input, { actor: ctx.actor }))
      return { id: link.id }
    }),

  renew: authorizedProcedure("clientLink:create")
    .input(clientActionLinkRenewInputSchema)
    .mutation(async ({ ctx, input }) => {
      const link = unwrapOutcome(await executeCommand(renewClientLink, input, { actor: ctx.actor }))
      return { id: link.id, url: clientActionLinkUrl(link.id) }
    }),

  /**
   * Exactly what the recipient's page shows, from the same builder, for as long as the link works.
   * Actions stay inert in the seller's view: opening the preview never decides or pays anything.
   */
  preview: authorizedProcedure("clientLink:read")
    .input(clientActionLinkIdInputSchema)
    .query(async ({ ctx, input }) => {
      const link = await loadClientActionLinkRow(input.id)
      if (!link || link.organizationId !== ctx.organizationId) throw new TRPCError({ code: "NOT_FOUND" })
      const state = clientActionLinkState(link, new Date())
      if (state !== "active") return { state, page: null }
      return { state, page: await buildClientActionPage(link, { verified: false }) }
    }),
})
