import type { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"

const templates = [
  {
    name: "Fixed-scope project",
    termsMarkdown:
      "# {{agreement.title}}\n\n{{seller.name}} will provide the following work for {{buyer.name}}.\n\n{{deliverables}}\n\nThe agreed total is {{agreement.total}}. This offer is valid until {{agreement.validUntil}}.\n\nChanges to the agreed scope require a new agreement. Payment is due according to the agreement's payment terms.\n\nThis template is not legal advice.",
  },
  {
    name: "Milestone project",
    termsMarkdown:
      "# {{agreement.title}}\n\n{{seller.name}} will provide these milestones for {{buyer.name}}.\n\n{{deliverables}}\n\nThe milestones, including any deposit, total {{agreement.total}}. This offer is valid until {{agreement.validUntil}}.\n\nEach milestone follows its agreed date and payment terms. Changes to scope require a new agreement.\n\nThis template is not legal advice.",
  },
]

export async function seedAgreementTemplates(db: Prisma.TransactionClient, organizationId: string) {
  // Serialize first opens and any future default changes on the parent organization.
  await db.$queryRaw`SELECT "id" FROM "organization" WHERE "id" = ${organizationId} FOR UPDATE`
  const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId } })
  if (organization.agreementTemplatesSeeded) return
  for (const template of templates) {
    await db.agreementTemplate.upsert({
      where: { organizationId_name: { organizationId, name: template.name } },
      create: { ...template, organizationId, isDefault: false },
      update: {},
    })
  }
  if (!(await db.agreementTemplate.findFirst({ where: { organizationId, isDefault: true } }))) {
    await db.agreementTemplate.update({
      where: { organizationId_name: { organizationId, name: templates[0]!.name } },
      data: { isDefault: true },
    })
  }
  await db.organization.update({ where: { id: organizationId }, data: { agreementTemplatesSeeded: true } })
}

export async function listAgreementTemplates(organizationId: string) {
  return prisma.$transaction(async (db) => {
    await seedAgreementTemplates(db, organizationId)
    return db.agreementTemplate.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, termsMarkdown: true, isDefault: true },
    })
  })
}
