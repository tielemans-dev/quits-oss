import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../../trpc/router"
import { executeCommand, type CommandOutcome } from "../../execute"
import {
  createAgreementDraft,
  updateAgreementDraft,
  deleteAgreementDraft,
  updateDeliverable,
} from "../../commands/agreements"
import { deleteContact } from "../../commands/contacts"
import { listAgreementTemplates } from "../templates"
import { getAgreement, listAgreements } from "../queries"
import { ALL_PERMISSIONS, roleHasPermission, type OrganizationRole } from "../../permissions"
import { actorCan, type AgentActor } from "../../actor"
import { agreementTools } from "../../agent-tools/tools/agreements"
import { getAgentTool, visibleAgentTools } from "../../agent-tools/registry"
import { createAgentKey, authenticateAgentSecret } from "../../agent-keys"
import { agentScopePresets } from "@quits/contracts/agent"

function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
type Org = Awaited<ReturnType<typeof createTestOrganization>>
function caller(org: Org, role: OrganizationRole = "admin") {
  return appRouter.createCaller({
    session: {
      user: { id: org.actors[role].userId, name: "Test", email: "test@example.test" },
      session: { activeOrganizationId: org.organizationId },
    },
  } as never)
}
const newDraft = (contactId: string) => ({
  contactId,
  title: "Website",
  validUntil: "2099-12-01",
  taxRate: 25,
  termsMarkdown: "**{{buyer.name}}**",
  notes: "private",
  deliverables: [
    { title: "Deposit", description: "Upfront", quantity: 1, unitPrice: 300, isDeposit: true },
    {
      title: "Website",
      description: "Build",
      quantity: 1,
      unitPrice: 700,
      agreedDate: "2099-11-01",
    },
  ],
})

describe("agreement role and agent scope matrix", () => {
  for (const role of ["admin", "member", "accountant"] as const) {
    for (const permission of ALL_PERMISSIONS.filter(
      (p) => p.startsWith("agreement:") || p.startsWith("deliverable:"),
    )) {
      it(`${role}: ${permission} requires the role and exact agent scope`, () => {
        const [resource, action] = permission.split(":")
        const expected =
          role === "admin" ||
          (role === "accountant"
            ? action === "read"
            : resource === "deliverable" || !["delete", "manageTemplates"].includes(action!))
        expect(roleHasPermission([role], permission)).toBe(expected)
        const actor: AgentActor = {
          kind: "agent",
          organizationId: "org",
          agentKeyId: "key",
          mode: "full_access",
          ownerRoles: [role],
          scopes: [permission],
          label: "test",
        }
        expect(actorCan(actor, permission)).toBe(expected)
        expect(actorCan({ ...actor, scopes: [] }, permission)).toBe(false)
        for (const tool of agreementTools) {
          const visible = visibleAgentTools(actor).some((entry) => entry.name === tool.name)
          expect(visible).toBe(expected && tool.permission === permission)
          if (!visible) expect(() => getAgentTool(actor, tool.name)).toThrow()
        }
        expect(
          visibleAgentTools({ ...actor, mode: "read_only" })
            .filter((tool) => agreementTools.some((a) => a.name === tool.name))
            .every((tool) => tool.kind === "query"),
        ).toBe(true)
      })
    }
  }
  it("registers the permission table, presets and draft and issuance tools", () => {
    expect(ALL_PERMISSIONS.filter((p) => p.startsWith("agreement:")).sort()).toEqual(
      ["create", "read", "update", "send", "delete", "accept", "close", "manageTemplates"]
        .map((a) => `agreement:${a}`)
        .sort(),
    )
    expect(ALL_PERMISSIONS.filter((p) => p.startsWith("deliverable:")).sort()).toEqual(
      ["read", "update", "deliver", "accept"].map((a) => `deliverable:${a}`).sort(),
    )
    expect(agentScopePresets.read_only_bookkeeper.scopes).toEqual(
      expect.arrayContaining(["agreement:read", "deliverable:read"]),
    )
    expect(agentScopePresets.drafting_assistant.scopes).toEqual(
      expect.arrayContaining([
        "agreement:create",
        "agreement:update",
        "agreement:send",
        "deliverable:update",
        "deliverable:deliver",
      ]),
    )
    expect(
      [createAgreementDraft, updateAgreementDraft, deleteAgreementDraft, updateDeliverable].every(
        (command) => !command.outwardFacing,
      ),
    ).toBe(true)
    expect(agreementTools.map((tool) => tool.name).sort()).toEqual(
      [
        "agreement_send",
        "agreement_issue",
        "agreement_resend",
        "agreement_send_read_link",
        "agreement_list",
        "agreement_get",
        "deliverable_list",
        "agreement_template_list",
        "agreement_create_draft",
        "agreement_update_draft",
        "agreement_delete_draft",
        "deliverable_update",
        "deliverable_mark_delivered",
      ].sort(),
    )
  })
})

describe.runIf(hasTestDatabase)("agreement foundation database behavior", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })
  async function setup() {
    const org = await createTestOrganization({
      roles: ["admin", "member", "accountant"],
      settings: { countryCode: "DK", currency: "DKK", taxRegime: "eu_vat" },
    })
    cleanups.push(org.cleanup)
    const contact = await prisma.contact.create({
      data: { organizationId: org.organizationId, name: "Buyer", email: "buyer@example.test" },
    })
    return { org, contact, api: caller(org) }
  }
  it("creates, edits, reprices and deletes through tRPC without allocating a number or sending", async () => {
    const { org, contact, api } = await setup()
    const settings = await prisma.orgSettings.findUniqueOrThrow({
      where: { organizationId: org.organizationId },
    })
    const draft = await api.agreements.createDraft(newDraft(contact.id))
    expect(draft).toMatchObject({
      number: null,
      status: "draft",
      issueDate: null,
      offerSnapshot: null,
      offerRevision: 0,
      total: 875,
      taxRate: 25,
      buyerSnapshot: { name: "Buyer" },
      sellerSnapshot: { companyName: settings.companyName },
    })
    expect(draft.deliverables).toHaveLength(2)
    const notesEdit = await api.agreements.updateDraft({ id: draft.id, notes: "updated" })
    expect(notesEdit).toMatchObject({
      title: draft.title,
      termsMarkdown: draft.termsMarkdown,
      taxRate: 25,
      total: 875,
    })
    expect(notesEdit.deliverables.map((l) => l.id)).toEqual(draft.deliverables.map((l) => l.id))
    const line = draft.deliverables[1]!
    await api.agreements.updateDeliverable({
      agreementId: draft.id,
      id: line.id,
      unitPrice: 800,
      expectedDate: "2099-11-02",
    })
    expect(await api.agreements.get({ id: draft.id })).toMatchObject({
      total: 1000,
      deliverables: [
        { id: draft.deliverables[0]!.id },
        { id: line.id, lineGross: 1000, expectedDate: new Date("2099-11-02") },
      ],
    })
    const buyer = await prisma.contact.create({
      data: { organizationId: org.organizationId, name: "Other buyer" },
    })
    await api.agreements.updateDraft({
      id: draft.id,
      contactId: buyer.id,
      currency: "JPY",
      taxRate: 10,
    })
    expect(await api.agreements.get({ id: draft.id })).toMatchObject({
      buyerSnapshot: { name: "Other buyer" },
      currency: "JPY",
      taxRate: 10,
    })
    const after = await prisma.orgSettings.findUniqueOrThrow({
      where: { organizationId: org.organizationId },
    })
    for (const key of [
      "invoiceNextNum",
      "quoteNextNum",
      "creditNoteNextNum",
      "agreementNextNum",
    ] as const)
      expect(after[key]).toBe(settings[key])
    expect(await prisma.job.count({ where: { organizationId: org.organizationId } })).toBe(0)
    await api.agreements.deleteDraft({ id: draft.id })
    expect(await prisma.deliverable.count({ where: { agreementId: draft.id } })).toBe(0)
    expect(
      await prisma.domainEvent.findMany({
        where: { organizationId: org.organizationId },
        select: { type: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        { type: "agreement.draft_created" },
        { type: "agreement.draft_updated" },
        { type: "deliverable.updated" },
        { type: "agreement.draft_deleted" },
      ]),
    )
  })
  it("isolates every query and command, including contacts, templates and child ids", async () => {
    const a = await setup(),
      b = await setup()
    const draft = await a.api.agreements.createDraft(newDraft(a.contact.id))
    const other = await b.api.agreements.createDraft(newDraft(b.contact.id))
    const templates = await b.api.agreements.listTemplates()
    expect(await listAgreements(b.org.organizationId)).toHaveLength(1)
    expect((await b.api.agreements.list()).map((item) => item.id)).toEqual([other.id])
    await expect(getAgreement(b.org.organizationId, draft.id)).rejects.toThrow()
    await expect(b.api.agreements.get({ id: draft.id })).rejects.toThrow()
    for (const run of [
      () => b.api.agreements.createDraft(newDraft(a.contact.id)),
      () =>
        a.api.agreements.createDraft({ ...newDraft(a.contact.id), templateId: templates[0]!.id }),
      () => b.api.agreements.updateDraft({ id: draft.id, title: "stolen" }),
      () => a.api.agreements.updateDraft({ id: draft.id, contactId: b.contact.id }),
      () => a.api.agreements.updateDraft({ id: draft.id, templateId: templates[0]!.id }),
      () => b.api.agreements.deleteDraft({ id: draft.id }),
      () =>
        b.api.agreements.updateDeliverable({
          id: draft.deliverables[0]!.id,
          agreementId: draft.id,
          title: "stolen",
        }),
      () =>
        b.api.agreements.updateDeliverable({
          id: draft.deliverables[0]!.id,
          agreementId: other.id,
          title: "stolen",
        }),
    ])
      await expect(run()).rejects.toThrow()
    expect(await a.api.agreements.get({ id: draft.id })).toMatchObject({
      title: "Website",
      contactId: a.contact.id,
      deliverables: [{ title: "Deposit" }, { title: "Website" }],
    })
    const key = await createAgentKey(b.org.actors.admin, {
      name: "Reader",
      mode: "full_access",
      scopes: [
        "agreement:read",
        "deliverable:read",
        "agreement:create",
        "agreement:update",
        "agreement:delete",
        "deliverable:update",
      ],
    })
    const actor = await authenticateAgentSecret(key.secret)
    const run = (name: string, input: unknown) => getAgentTool(actor, name).run({ actor }, input)
    await expect(run("agreement_get", { id: draft.id })).rejects.toThrow()
    await expect(run("deliverable_list", { agreementId: draft.id })).rejects.toThrow()
    expect(await run("agreement_list", { limit: 50 })).toMatchObject({
      items: [{ id: other.id }],
      nextCursor: null,
    })
    expect(await run("agreement_template_list", {})).toEqual(templates)
    for (const [name, input] of [
      ["agreement_create_draft", newDraft(a.contact.id)],
      ["agreement_update_draft", { id: draft.id, title: "x" }],
      ["agreement_delete_draft", { id: draft.id }],
      ["deliverable_update", { id: draft.deliverables[0]!.id, agreementId: draft.id, title: "x" }],
    ] as const) {
      expect(await run(name, { ...input, clientRequestId: name })).toMatchObject({
        status: "failed",
      })
    }
  })
  it("enforces roles at the real router and exact scopes at execution", async () => {
    const { org, contact, api } = await setup()
    const draft = await api.agreements.createDraft(newDraft(contact.id))
    const member = caller(org, "member"),
      accountant = caller(org, "accountant")
    for (const allowed of [member, accountant]) {
      expect(await allowed.agreements.get({ id: draft.id })).toMatchObject({ id: draft.id })
      expect(await allowed.agreements.listTemplates()).toHaveLength(2)
    }
    await member.agreements.updateDraft({ id: draft.id, title: "Member edit" })
    await member.agreements.updateDeliverable({
      id: draft.deliverables[0]!.id,
      agreementId: draft.id,
      title: "Member deposit",
    })
    await expect(member.agreements.deleteDraft({ id: draft.id })).rejects.toThrow()
    for (const run of [
      () => accountant.agreements.createDraft(newDraft(contact.id)),
      () => accountant.agreements.updateDraft({ id: draft.id, title: "x" }),
      () => accountant.agreements.deleteDraft({ id: draft.id }),
      () =>
        accountant.agreements.updateDeliverable({
          id: draft.deliverables[0]!.id,
          agreementId: draft.id,
          title: "x",
        }),
    ])
      await expect(run()).rejects.toThrow()
    const key = await createAgentKey(org.actors.admin, {
      name: "Draft-only",
      mode: "approval_required",
      scopes: ["agreement:create"],
    })
    const actor = await authenticateAgentSecret(key.secret)
    completed(
      await executeCommand(createAgreementDraft, newDraft(contact.id), {
        actor,
        clientRequestId: "first",
      }),
    )
    expect(
      await executeCommand(
        updateAgreementDraft,
        { id: draft.id, title: "x" },
        { actor, clientRequestId: "no-scope" },
      ),
    ).toMatchObject({ status: "failed" })
  })
  it("serializes concurrent child edits and preserves both totals", async () => {
    const { org, contact, api } = await setup()
    const draft = await api.agreements.createDraft(newDraft(contact.id))
    const outcomes = await Promise.all(
      draft.deliverables.map((line, index) =>
        executeCommand(
          updateDeliverable,
          {
            id: line.id,
            agreementId: draft.id,
            unitPrice: index === 0 ? 400 : 800,
          },
          { actor: org.actors.admin },
        ),
      ),
    )
    outcomes.forEach(completed)
    expect(await api.agreements.get({ id: draft.id })).toMatchObject({ total: 1000 })
  })
  it("seeds concurrently once, preserves edits/defaults and enforces the partial index", async () => {
    const { org, api } = await setup()
    const results = await Promise.all(
      Array.from({ length: 12 }, () => listAgreementTemplates(org.organizationId)),
    )
    results.forEach((templates) =>
      expect(templates.map((item) => item.id)).toEqual(results[0]!.map((item) => item.id)),
    )
    expect(results[0]).toHaveLength(2)
    expect(results[0]!.filter((item) => item.isDefault)).toHaveLength(1)
    const nondefault = results[0]!.find((item) => !item.isDefault)!
    await expect(
      prisma.agreementTemplate.update({ where: { id: nondefault.id }, data: { isDefault: true } }),
    ).rejects.toThrow()
    await prisma.$transaction(async (db) => {
      await db.agreementTemplate.updateMany({
        where: { organizationId: org.organizationId },
        data: { isDefault: false },
      })
      await db.agreementTemplate.update({
        where: { id: nondefault.id },
        data: { isDefault: true, termsMarkdown: "Preserved" },
      })
    })
    expect(await api.agreements.listTemplates()).toMatchObject([
      { id: nondefault.id, isDefault: true, termsMarkdown: "Preserved" },
      { isDefault: false },
    ])
  })
  it("refuses contact deletion until the agreement is deleted, with a database FK backstop", async () => {
    const { org, contact, api } = await setup()
    const draft = await api.agreements.createDraft(newDraft(contact.id))
    expect(
      await executeCommand(deleteContact, { id: contact.id }, { actor: org.actors.admin }),
    ).toMatchObject({ status: "failed", error: { code: "contact_in_use" } })
    await expect(prisma.contact.delete({ where: { id: contact.id } })).rejects.toThrow()
    await api.agreements.deleteDraft({ id: draft.id })
    completed(await executeCommand(deleteContact, { id: contact.id }, { actor: org.actors.admin }))
  })
  it("refuses non-draft/sending mutations and lifecycle input fields", async () => {
    const { contact, api } = await setup()
    const draft = await api.agreements.createDraft(newDraft(contact.id))
    for (const data of [
      { status: "sent" },
      { status: "draft", lastEmailAttemptOutcome: "sending" },
    ]) {
      await prisma.agreement.update({ where: { id: draft.id }, data })
      for (const run of [
        () => api.agreements.updateDraft({ id: draft.id, title: "x" }),
        () => api.agreements.deleteDraft({ id: draft.id }),
        () =>
          api.agreements.updateDeliverable({
            id: draft.deliverables[0]!.id,
            agreementId: draft.id,
            title: "Changed offer field",
          }),
      ])
        await expect(run()).rejects.toThrow()
    }
    await expect(
      api.agreements.updateDraft({ id: draft.id, status: "accepted" } as never),
    ).rejects.toThrow()
  })
  it("idempotently replays agent creation and refuses deletion with pending approval", async () => {
    const { org, contact, api } = await setup()
    const { secret, key } = await createAgentKey(org.actors.admin, {
      name: "Draft",
      mode: "approval_required",
      scopes: ["agreement:create"],
    })
    const actor = await authenticateAgentSecret(secret)
    const tool = getAgentTool(actor, "agreement_create_draft")
    const input = { ...newDraft(contact.id), clientRequestId: "idempotent-draft" }
    const first = await tool.run({ actor }, input)
    expect(await tool.run({ actor }, input)).toEqual(first)
    expect(await api.agreements.list()).toHaveLength(1)
    const [draft] = await api.agreements.list()
    const receipt = await prisma.commandReceipt.create({
      data: {
        organizationId: org.organizationId,
        actorKey: `agent:${actor.agentKeyId}`,
        clientRequestId: "future-send",
        commandType: "agreement.send",
        status: "awaiting_approval",
      },
    })
    await prisma.approvalRequest.create({
      data: {
        organizationId: org.organizationId,
        agentKeyId: key.id,
        commandReceiptId: receipt.id,
        commandType: "agreement.send",
        command: { id: draft!.id },
        summary: "Pending",
        expiresAt: new Date("2099-12-01"),
      },
    })
    await expect(api.agreements.deleteDraft({ id: draft!.id })).rejects.toThrow("pending approval")
  })
})
