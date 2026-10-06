import type { SystemActor } from "../../domain/actor"
import { recordQuoteCustomerDecision } from "../../domain/commands/quotes"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../db"
import {
  getQuotePublicDecisionState,
  type QuotePublicDecision,
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
    decision: QuotePublicDecision
    rejectionReason?: string
  }
) {
  const payload = verifyQuotePublicToken(token, secret)
  if (!payload) {
    throw new Error("Invalid public quote link")
  }

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
      decision: input.decision,
      rejectionReason: input.rejectionReason,
    },
    { actor: customerLinkActor(target.organizationId) }
  )
  if (outcome.status !== "completed") {
    throw new Error(
      outcome.status === "awaiting_approval" ? "Quote decision is pending" : outcome.error.message
    )
  }

  const quote = outcome.result
  return {
    quote,
    decisionState: getQuotePublicDecisionState({
      status: quote.status,
      publicDecisionAt: quote.publicDecisionAt,
    }),
  }
}
