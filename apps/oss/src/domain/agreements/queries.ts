import { deliverableProgress } from "./progress"
import type { z } from "zod"
import type { agreementListInputSchema } from "@quits/contracts/agreements"
import { prisma } from "../../lib/db"
import { afterNewest, decodeCursor } from "../agent-tools/pagination"
import { NotFound } from "../errors"

export function listAgreements(
  organizationId: string,
  input: z.infer<typeof agreementListInputSchema> = {},
  page?: { limit: number; cursor?: string },
) {
  return prisma.agreement.findMany({
    where: { ...input, ...afterNewest(decodeCursor(page?.cursor)), organizationId },
    ...(page ? { take: page.limit + 1 } : {}),
    include: { contact: { select: { id: true, name: true, email: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  })
}
export async function getAgreement(organizationId: string, id: string) {
  const agreement = await prisma.agreement.findFirst({
    where: { id, organizationId },
    include: { contact: true, deliverables: { orderBy: { sortOrder: "asc" } } },
  })
  if (!agreement) throw new NotFound({ message: "Agreement not found", entity: "agreement", id })
  return agreement
}

export function serializeAgreement<
  Document extends {
    subtotalNet: { toNumber(): number }
    totalTax: { toNumber(): number }
    totalGross: { toNumber(): number }
    taxRate: { toNumber(): number }
  },
>(agreement: Document) {
  return {
    ...agreement,
    subtotal: agreement.subtotalNet.toNumber(),
    taxAmount: agreement.totalTax.toNumber(),
    total: agreement.totalGross.toNumber(),
    taxRate: agreement.taxRate.toNumber(),
  }
}
export function serializeDeliverable<
  Line extends {
    quantity: { toNumber(): number }
    unitPriceNet: { toNumber(): number }
    unitPriceGross: { toNumber(): number }
    lineNet: { toNumber(): number }
    lineTax: { toNumber(): number }
    lineGross: { toNumber(): number }
    taxRate: { toNumber(): number }
  },
>(line: Line) {
  return {
    ...line,
    quantity: line.quantity.toNumber(),
    unitPriceNet: line.unitPriceNet.toNumber(),
    unitPriceGross: line.unitPriceGross.toNumber(),
    lineNet: line.lineNet.toNumber(),
    lineTax: line.lineTax.toNumber(),
    lineGross: line.lineGross.toNumber(),
    taxRate: line.taxRate.toNumber(),
  }
}
export function serializeAgreementDetail(agreement: Awaited<ReturnType<typeof getAgreement>>) {
  return {
    ...serializeAgreement(agreement),
    deliverables: agreement.deliverables.map(serializeDeliverable),
    progress: deliverableProgress(agreement.deliverables),
  }
}
