import type { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"

import { translate } from "../../lib/i18n/translate"

export function defaultAgreementTemplates(locale?: string | null) {
  return (["fixed", "milestone"] as const).map(kind => ({
    name: translate(`agreements.templates.${kind}.name`, locale),
    termsMarkdown: translate(`agreements.templates.${kind}.terms`, locale),
  }))
}

/** Translate only untouched built-in content, without updating the persisted template. */
export function presentAgreementTemplate<T extends { name: string; termsMarkdown: string }>(template: T, locale?: string | null): T {
  for (const language of ["en", "da"]) {
    const index = defaultAgreementTemplates(language).findIndex(seed => seed.name === template.name && seed.termsMarkdown === template.termsMarkdown)
    if (index !== -1) return { ...template, ...defaultAgreementTemplates(locale)[index]! }
  }
  return template
}

export async function seedAgreementTemplates(db: Prisma.TransactionClient, organizationId: string) {
  // Serialize first opens and any future default changes on the parent organization.
  await db.$queryRaw`SELECT "id" FROM "organization" WHERE "id" = ${organizationId} FOR UPDATE`
  const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { settings: { select: { locale: true } } } })
  if (organization.agreementTemplatesSeeded) return
  const templates = defaultAgreementTemplates(organization.settings?.locale)
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
    const settings = await db.orgSettings.findUnique({ where: { organizationId }, select: { locale: true } })
    const templates = await db.agreementTemplate.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, termsMarkdown: true, isDefault: true },
    })
    return templates.map(template => presentAgreementTemplate(template, settings?.locale))
  })
}
