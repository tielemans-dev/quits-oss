import { Effect } from "effect"
import { z } from "zod"
import {
  clientActionLinkCreateInputSchema,
  clientActionLinkIdInputSchema,
  clientActionLinkRenewInputSchema,
  normalizeCapabilities,
  type ClientActionRecordKind,
} from "@quits/contracts/client-actions"
import { Prisma } from "../../../generated/prisma/client"
import { ensureEmailProvider } from "../../lib/email"
import { defineCommand } from "../command"
import { humanOnly } from "../agreements/fulfillment"
import { InvalidState, NotFound, ValidationFailed } from "../errors"
import { Command, Db } from "../services"

const DAY_MS = 86_400_000
const unavailable = (index: number) =>
  new ValidationFailed({
    message: "This record cannot be shared with the client yet",
    issues: [{ path: `grants.${index}.recordId`, message: "This record cannot be shared with the client yet" }],
  })

/**
 * The record's current link generation, when the contact may be given access to it at all.
 * Always scoped to the organization and contact of the link: a grant cannot reach across either.
 */
export const grantableKeyVersion = (
  scope: { organizationId: string; contactId: string },
  kind: ClientActionRecordKind,
  recordId: string,
) =>
  Effect.gen(function* () {
    const db = yield* Db
    if (kind === "agreement") {
      const agreement = yield* Effect.promise(() =>
        db.agreement.findFirst({
          where: { id: recordId, ...scope, offerSnapshot: { not: Prisma.DbNull }, status: { not: "draft" } },
          select: { publicAccessKeyVersion: true },
        }),
      )
      return agreement?.publicAccessKeyVersion ?? null
    }
    if (kind === "deliverable") {
      const line = yield* Effect.promise(() =>
        db.deliverable.findFirst({
          where: {
            id: recordId,
            isDeposit: false,
            status: { in: ["delivered", "accepted", "changes_requested"] },
            agreement: { ...scope, status: "accepted", offerSnapshot: { not: Prisma.DbNull } },
          },
          select: { agreement: { select: { publicAccessKeyVersion: true } } },
        }),
      )
      return line?.agreement.publicAccessKeyVersion ?? null
    }
    const invoice = yield* Effect.promise(() =>
      db.invoice.findFirst({
        where: {
          id: recordId,
          ...scope,
          publicPaymentIssuedAt: { not: null },
          status: { in: ["sent", "overdue", "paid", "credited"] },
        },
        select: { publicPaymentKeyVersion: true },
      }),
    )
    return invoice?.publicPaymentKeyVersion ?? null
  })

export const createClientLink = defineCommand({
  type: "client_link.create",
  permission: "clientLink:create",
  outwardFacing: false,
  input: clientActionLinkCreateInputSchema,
  summarize: (input) => `Create a client action page for ${input.recipientName}`,
  handle: (input) =>
    Effect.gen(function* () {
      yield* humanOnly
      const db = yield* Db
      const command = yield* Command
      const contact = yield* Effect.promise(() =>
        db.contact.findFirst({
          where: { id: input.contactId, organizationId: command.organizationId },
          select: { id: true },
        }),
      )
      if (!contact)
        return yield* new NotFound({ message: "Contact not found", entity: "contact", id: input.contactId })
      if (input.verification === "email_code") {
        // A link that cannot send its code would lock its approver out for good.
        const configured = yield* Effect.try({ try: () => ensureEmailProvider(), catch: () => false as const }).pipe(
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        )
        if (!configured)
          return yield* new InvalidState({
            code: "email_unavailable",
            message: "Email must be set up to verify recipients before approval",
          })
      }
      const scope = { organizationId: command.organizationId, contactId: contact.id }
      const grants: { recordKind: string; recordId: string; capabilities: string[]; keyVersion: number }[] = []
      for (const [index, grant] of input.grants.entries()) {
        const keyVersion = yield* grantableKeyVersion(scope, grant.kind, grant.recordId)
        if (keyVersion === null) return yield* unavailable(index)
        grants.push({
          recordKind: grant.kind,
          recordId: grant.recordId,
          capabilities: normalizeCapabilities(grant.kind, grant.capabilities),
          keyVersion,
        })
      }
      const expiresAt = new Date(command.now.getTime() + input.expiresInDays * DAY_MS)
      const link = yield* Effect.promise(() =>
        db.clientActionLink.create({
          data: {
            ...scope,
            recipientName: input.recipientName,
            recipientEmail: input.recipientEmail ?? null,
            verification: input.verification,
            expiresAt,
            createdBy: command.actor.label,
            grants: { create: grants },
          },
          include: { grants: true },
        }),
      )
      command.emit({
        aggregateType: "contact",
        aggregateId: contact.id,
        type: "client_link.created",
        payload: {
          linkId: link.id,
          recipientName: input.recipientName,
          expiresAt: expiresAt.toISOString(),
          verification: input.verification,
          grants: grants.map(({ recordKind, recordId, capabilities }) => ({ kind: recordKind, recordId, capabilities })),
        },
      })
      return link
    }),
})

const ownLink = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const link = yield* Effect.promise(() =>
      db.clientActionLink.findFirst({ where: { id, organizationId }, include: { grants: true } }),
    )
    if (!link) return yield* new NotFound({ message: "Client link not found", entity: "client_link", id })
    return link
  })

export const revokeClientLink = defineCommand({
  type: "client_link.revoke",
  permission: "clientLink:revoke",
  outwardFacing: false,
  input: clientActionLinkIdInputSchema,
  summarize: ({ id }) => `Revoke client action page ${id}`,
  handle: (input) =>
    Effect.gen(function* () {
      yield* humanOnly
      const db = yield* Db
      const command = yield* Command
      const link = yield* ownLink(input.id)
      // Revoking twice keeps the first instant and records nothing more.
      if (link.revokedAt) return link
      const updated = yield* Effect.promise(() =>
        db.clientActionLink.update({
          where: { id: link.id },
          data: { revokedAt: command.now },
          include: { grants: true },
        }),
      )
      command.emit({
        aggregateType: "contact",
        aggregateId: link.contactId,
        type: "client_link.revoked",
        payload: { linkId: link.id, recipientName: link.recipientName },
      })
      return updated
    }),
})

/**
 * Gives an expired or stale link new life at the same address: a new expiry, and every grant moved
 * to the record's current link generation. A grant whose record can no longer be shared is
 * dropped. Revoked links are final: the seller makes a new one.
 */
export const renewClientLink = defineCommand({
  type: "client_link.renew",
  permission: "clientLink:create",
  outwardFacing: false,
  input: clientActionLinkRenewInputSchema,
  summarize: ({ id }) => `Renew client action page ${id}`,
  handle: (input) =>
    Effect.gen(function* () {
      yield* humanOnly
      const db = yield* Db
      const command = yield* Command
      const link = yield* ownLink(input.id)
      if (link.revokedAt)
        return yield* new InvalidState({ code: "revoked", message: "A revoked link cannot be renewed" })
      const scope = { organizationId: link.organizationId, contactId: link.contactId }
      const dropped: string[] = []
      for (const grant of link.grants) {
        const keyVersion = yield* grantableKeyVersion(scope, grant.recordKind as ClientActionRecordKind, grant.recordId)
        if (keyVersion === null) {
          dropped.push(grant.id)
          continue
        }
        if (keyVersion !== grant.keyVersion)
          yield* Effect.promise(() => db.clientActionGrant.update({ where: { id: grant.id }, data: { keyVersion } }))
      }
      if (dropped.length)
        yield* Effect.promise(() => db.clientActionGrant.deleteMany({ where: { id: { in: dropped } } }))
      const expiresAt = new Date(command.now.getTime() + input.expiresInDays * DAY_MS)
      const updated = yield* Effect.promise(() =>
        db.clientActionLink.update({ where: { id: link.id }, data: { expiresAt }, include: { grants: true } }),
      )
      command.emit({
        aggregateType: "contact",
        aggregateId: link.contactId,
        type: "client_link.renewed",
        payload: { linkId: link.id, recipientName: link.recipientName, expiresAt: expiresAt.toISOString(), droppedGrants: dropped.length },
      })
      return updated
    }),
})

/** Recorded after a visitor's action succeeded, so the seller sees who did what through which link. */
export const recordClientLinkAction = defineCommand({
  type: "client_link.record_action",
  permission: "clientLink:read",
  outwardFacing: false,
  input: z
    .object({
      linkId: z.string().min(1),
      recordKind: z.enum(["agreement", "deliverable", "invoice"]),
      recordId: z.string().min(1),
      action: z.enum(["accept", "decline", "request_changes", "start_payment"]),
    })
    .strict(),
  summarize: () => "Record a client action",
  handle: (input) =>
    Effect.gen(function* () {
      const command = yield* Command
      if (command.actor.kind !== "system" || command.actor.reason !== "customer_link")
        return yield* new InvalidState({ code: "invalid", message: "Client actions are recorded from the page" })
      const link = yield* ownLink(input.linkId)
      command.emit({
        aggregateType: "contact",
        aggregateId: link.contactId,
        type: "client_link.action_taken",
        payload: {
          linkId: link.id,
          recipientName: link.recipientName,
          kind: input.recordKind,
          recordId: input.recordId,
          action: input.action,
        },
      })
    }),
})

export const clientLinkCommands = [createClientLink, revokeClientLink, renewClientLink] as const
