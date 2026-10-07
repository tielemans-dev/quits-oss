import { Effect } from "effect"
import {
  agreementTemplateCreateInputSchema,
  agreementTemplateUpdateInputSchema,
  agreementIdInputSchema,
} from "@quits/contracts/agreements"
import { defineCommand } from "../command"
import { Command, Db } from "../services"
import { InvalidState, NotFound } from "../errors"
import { seedAgreementTemplates } from "../agreements/templates"

const prepare = (id?: string, name?: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    // Organization lock also serializes seeding and changes to the single default.
    yield* Effect.promise(() => seedAgreementTemplates(db, organizationId))
    const template = id
      ? yield* Effect.promise(() =>
          db.agreementTemplate.findFirst({ where: { id, organizationId } }),
        )
      : null
    if (id && !template)
      return yield* new NotFound({
        entity: "agreementTemplate",
        id,
        message: "Agreement template not found",
      })
    if (name) {
      const duplicate = yield* Effect.promise(() =>
        db.agreementTemplate.findFirst({
          where: { organizationId, name, ...(id ? { id: { not: id } } : {}) },
        }),
      )
      if (duplicate)
        return yield* new InvalidState({
          code: "template_name_exists",
          message: "An agreement template with this name already exists.",
        })
    }
    return { db, organizationId, template }
  })
const clearDefault = (organizationId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* Effect.promise(() =>
      db.agreementTemplate.updateMany({
        where: { organizationId, isDefault: true },
        data: { isDefault: false },
      }),
    )
  })
export const createAgreementTemplate = defineCommand({
  type: "agreement_template.create",
  permission: "agreement:manageTemplates",
  outwardFacing: false,
  input: agreementTemplateCreateInputSchema,
  summarize: (input) => `Create agreement template ${input.name}`,
  handle: (input) =>
    Effect.gen(function* () {
      const { db, organizationId } = yield* prepare(undefined, input.name)
      if (input.isDefault) yield* clearDefault(organizationId)
      const template = yield* Effect.promise(() =>
        db.agreementTemplate.create({ data: { organizationId, ...input } }),
      )
      const command = yield* Command
      command.emit({
        aggregateType: "agreementTemplate",
        aggregateId: template.id,
        type: "agreement_template.created",
        payload: { name: template.name, isDefault: template.isDefault },
      })
      return template
    }),
})
export const updateAgreementTemplate = defineCommand({
  type: "agreement_template.update",
  permission: "agreement:manageTemplates",
  outwardFacing: false,
  input: agreementTemplateUpdateInputSchema,
  summarize: (input) => `Update agreement template ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const { db, organizationId } = yield* prepare(input.id, input.name)
      if (input.isDefault) yield* clearDefault(organizationId)
      const { id, ...data } = input
      const template = yield* Effect.promise(() =>
        db.agreementTemplate.update({ where: { id }, data }),
      )
      const command = yield* Command
      command.emit({
        aggregateType: "agreementTemplate",
        aggregateId: id,
        type: "agreement_template.updated",
        payload: { fields: Object.keys(data) },
      })
      return template
    }),
})
export const deleteAgreementTemplate = defineCommand({
  type: "agreement_template.delete",
  permission: "agreement:manageTemplates",
  outwardFacing: false,
  input: agreementIdInputSchema,
  summarize: (input) => `Delete agreement template ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const { db, template } = yield* prepare(input.id)
      yield* Effect.promise(() =>
        db.agreementTemplate.delete({ where: { id: input.id } }),
      )
      const command = yield* Command
      const name = template!.name
      command.emit({
        aggregateType: "agreementTemplate",
        aggregateId: input.id,
        type: "agreement_template.deleted",
        payload: { name },
      })
      return { id: input.id }
    }),
})
export const agreementTemplateCommands = [
  createAgreementTemplate,
  updateAgreementTemplate,
  deleteAgreementTemplate,
] as const
