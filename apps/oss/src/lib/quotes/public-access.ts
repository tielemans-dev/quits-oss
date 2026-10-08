import { publicQuoteDecisionInputSchema } from "@quits/contracts/quotes"
import { recordPublicLinkAttempt } from "../public-links/rate-limit"
import type { SystemActor } from "../../domain/actor"
import { recordQuoteCustomerDecision } from "../../domain/commands/quotes"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../db"
import { publicPresentationSettingsSelect } from "../documents/public-presentation"
import {
  getQuotePublicDecisionState,
  verifyQuotePublicToken,
} from "./public"

export async function loadPublicQuoteByToken(token: string, secret: string) {
  const payload = verifyQuotePublicToken(token, secret)
  if (!payload) {
    return null
  }

  const quote = await prisma.quote.findFirst({
    where: {
      id: payload.quoteId,
      publicAccessKeyVersion: payload.keyVersion,
      publicAccessIssuedAt: {
        not: null,
      },
      status: {
        in: ["sent", "accepted", "rejected"],
      },
    },
    include: {
      contact: {
        select: {
          name: true,
          email: true,
          company: true,
        },
      },
      items: {
        orderBy: { sortOrder: "asc" },
      },
      invoices: {
        select: { id: true, number: true, status: true },
      },
      // Language, timezone, name and logo of the seller, for presenting the page.
      organization: {
        select: { settings: { select: publicPresentationSettingsSelect } },
      },
    },
  })

  if (!quote) {
    return null
  }

  return {
    quote,
    decisionState: getQuotePublicDecisionState({
      status: quote.status,
      publicDecisionAt: quote.publicDecisionAt,
    }),
  }
}

/** Customers act through the signed link rather than an account. */
function customerLinkActor(organizationId: string): SystemActor {
  return {
    kind: "system",
    organizationId,
    reason: "customer_link",
    label: "Customer (public quote link)",
  }
}

export async function decidePublicQuoteByToken(
  token: string,
  secret: string,
  input: {
    decision: unknown
    rejectionReason?: unknown
  }
) {
  const payload = verifyQuotePublicToken(token, secret)
  if (!payload) {
    throw new Error("Invalid public quote link")
  }

  await recordPublicLinkAttempt({
    documentKind: "quote",
    documentId: payload.quoteId,
    scope: payload.scope,
    keyVersion: payload.keyVersion,
    targetId: null,
    revision: 0,
  })

  const parsed = publicQuoteDecisionInputSchema.parse({ ...input, token })

  const target = await prisma.quote.findUnique({
    where: { id: payload.quoteId },
    select: { organizationId: true },
  })
  if (!target) {
    throw new Error("Quote not found")
  }

  const outcome = await executeCommand(
    recordQuoteCustomerDecision,
    {
      quoteId: payload.quoteId,
      keyVersion: payload.keyVersion,
      decision: parsed.decision,
      rejectionReason: parsed.rejectionReason,
    },
    { actor: customerLinkActor(target.organizationId) }
  )
  if (outcome.status !== "completed") {
    throw new Error(
      outcome.status === "awaiting_approval" ? "Quote decision is pending" : outcome.error.message
    )
  }

  // The decided quote is presented like a loaded one, so the seller's identity stays on the page.
  const settings = await prisma.orgSettings.findUnique({
    where: { organizationId: target.organizationId },
    select: publicPresentationSettingsSelect,
  })
  const quote = { ...outcome.result, organization: { settings } }
  return {
    quote,
    decisionState: getQuotePublicDecisionState({
      status: quote.status,
      publicDecisionAt: quote.publicDecisionAt,
    }),
  }
}
