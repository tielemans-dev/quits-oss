import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { prisma } from "../../lib/db"
import { executeCommand } from "../execute"
import { recordStripeCheckoutPayment } from "../commands/payments"
import { deleteContact } from "../commands/contacts"
import {
  recordSettlementEvidence,
  decideSettlementEvidence,
} from "../commands/settlement-provenance"
import {
  settlementProvenanceHistory,
  PROCESSING_REVIEW_WINDOW_MS,
} from "../documents/settlement-provenance"
import type {
  SettlementEvidenceInput,
  SettlementEvidenceDecision,
} from "@quits/contracts/settlement-provenance"
import { appRouter } from "../../trpc/router"

type DecisionInput<T = SettlementEvidenceDecision> = T extends SettlementEvidenceDecision
  ? Omit<T, "requestId" | "reason" | "evidence"> & Partial<Pick<T, "reason" | "evidence">>
  : never

describe.skipIf(!hasTestDatabase)("settlement provenance", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it("exposes original receipt attribution without claiming independent verification", async () => {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const userId = org.actors.admin.userId
    const caller = appRouter.createCaller({
      session: {
        user: { id: userId, email: `${userId}@example.test`, name: userId },
        session: { activeOrganizationId: org.organizationId },
      },
    } as never)
    const contact = await caller.contacts.create({ name: "Provenance customer" })
    const invoice = await caller.invoices.create({
      contactId: contact.id,
      dueDate: "2099-01-01",
      items: [{ description: "Work", quantity: 1, unitPrice: 1000 }],
    })
    const recorded = await caller.payments.recordReceipt({
      requestId: randomUUID(),
      contactId: contact.id,
      currency: "USD",
      netAmount: "1000",
      feeAmount: "0",
      paidAt: "2026-01-15",
      method: "bank_transfer",
      reference: randomUUID(),
      reason: "Seller confirmed receipt",
      evidence: "https://evidence.example.test/manual/1",
    })
    const listed = await caller.payments.receipts({ invoiceId: invoice.id })
    expect(listed.receipts.find((row) => row.id === recorded.receiptId)).toMatchObject({
      provenance: {
        state: "received",
        recordedBy: `user:${userId}`,
        recordedAt: expect.any(String),
        verifiedBy: null,
        verifiedAt: null,
      },
    })
  })
  function callerFor(organizationId: string, userId: string) {
    return appRouter.createCaller({
      session: {
        user: { id: userId, email: `${userId}@example.test`, name: userId },
        session: { activeOrganizationId: organizationId },
      },
    } as never)
  }
  const evidence = {
    reason: "Reviewed original statement",
    evidence: "https://evidence.example.test/statement/1",
  }
  async function setup(total = 1000) {
    const org = await createTestOrganization({
      roles: ["admin", "member", "accountant"],
      settings: { currency: "DKK" },
    })
    cleanups.push(org.cleanup)
    const caller = callerFor(org.organizationId, org.actors.admin.userId)
    const contact = await caller.contacts.create({
      name: "Customer",
      email: "provenance@example.test",
    })
    const invoice = await caller.invoices.create({
      contactId: contact.id,
      currency: "DKK",
      dueDate: "2099-01-01",
      taxRate: 0,
      items: [{ description: "Work", quantity: 1, unitPrice: total }],
    })
    await caller.invoices.send({ id: invoice.id, allowSendWithoutEmail: true })
    const facts = (extra: Partial<SettlementEvidenceInput> = {}): SettlementEvidenceInput => ({
      requestId: randomUUID(),
      contactId: contact.id,
      source: "bank",
      accountReference: "test-bank-account",
      transactionReference: randomUUID(),
      eventReference: randomUUID(),
      state: "received",
      occurredAt: "2026-01-15T12:00:00.000Z",
      currency: "DKK",
      netAmount: "1000",
      feeAmount: "0",
      ...evidence,
      ...extra,
    })
    const record = async (extra: Partial<SettlementEvidenceInput> = {}) => {
      const input = facts(extra)
      return { input, ...(await caller.payments.recordEvidence(input)) }
    }
    const identity = (value: string) => ({
      kind: "transaction_reference" as const,
      value,
      ...evidence,
    })
    const decision = (
      extra: DecisionInput,
    ): SettlementEvidenceDecision =>
      ({ requestId: randomUUID(), ...evidence, ...extra }) as SettlementEvidenceDecision
    const act = async (input: SettlementEvidenceDecision) => {
      const preview = await caller.payments.previewEvidenceDecision(input)
      return caller.payments.decideEvidence({ decision: input, previewToken: preview.previewToken })
    }
    const confirm = (observation: { evidenceId: string; input: SettlementEvidenceInput }) =>
      act(
        decision({
          action: "confirm",
          evidenceId: observation.evidenceId,
          method: "bank_transfer",
          identity: identity(observation.input.transactionReference),
        } as SettlementEvidenceDecision),
      )
    const manual = (netAmount = "1000", feeAmount = "0", currency = "DKK") =>
      caller.payments.recordReceipt({
        requestId: randomUUID(),
        contactId: contact.id,
        netAmount,
        feeAmount,
        currency,
        paidAt: "2026-01-15",
        method: "bank_transfer",
        reference: randomUUID(),
        ...evidence,
        ...(feeAmount !== "0" ? { feeEvidence: evidence } : {}),
      })
    const match = (evidenceId: string, receiptId: string, transaction: string) =>
      act(
        decision({
          action: "match",
          evidenceId,
          receiptId,
          identity: identity(transaction),
        } as SettlementEvidenceDecision),
      )
    const allocate = async (
      receiptId: string,
      receiptAmount: string,
      invoiceAmount = receiptAmount,
    ) => {
      const input = {
        requestId: randomUUID(),
        receiptId,
        allocations: [
          {
            invoiceId: invoice.id,
            receiptAmount,
            invoiceAmount,
            ...(receiptAmount !== invoiceAmount ? { exchangeEvidence: evidence } : {}),
          },
        ],
        ...evidence,
      }
      const preview = await caller.payments.previewAllocation(input)
      return caller.payments.allocateReceipt({ ...input, previewToken: preview.previewToken })
    }
    return {
      org,
      caller,
      contact,
      invoice,
      facts,
      record,
      identity,
      decision,
      act,
      confirm,
      manual,
      match,
      allocate,
    }
  }

  it("keeps evidence instants distinct from organization calendar payment dates", async () => {
    const s = await setup()
    await prisma.orgSettings.update({ where: { organizationId: s.org.organizationId }, data: { timezone: "Europe/Copenhagen" } })
    const occurredAt = "2026-03-29T00:30:45.123Z"
    const bank = await s.record({ occurredAt })
    const confirmed = await s.confirm(bank)
    const manual = await s.manual()
    expect((await prisma.settlementEvidence.findUniqueOrThrow({ where: { id: bank.evidenceId } })).occurredAt.toISOString()).toBe(occurredAt)
    expect((await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: confirmed.receiptId } })).paidAt.toISOString()).toBe(occurredAt)
    expect((await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: manual.receiptId } })).paidAt.toISOString()).toBe("2026-01-14T23:00:00.000Z")
    await s.allocate(confirmed.receiptId, "400")
    expect((await prisma.payment.findFirstOrThrow({ where: { receiptId: confirmed.receiptId } })).paidAt.toISOString()).toBe(occurredAt)
  })

  it("keeps verified receipt cash separate from mark-paid undo and a later linked return", async () => {
    const s = await setup()
    const bank = await s.record({ netAmount: "400" })
    const receipt = await s.confirm(bank)
    await s.allocate(receipt.receiptId, "400")
    const allocation = await prisma.payment.findFirstOrThrow({ where: { receiptId: receipt.receiptId } })
    const input = { invoiceId: s.invoice.id, requestId: randomUUID() }
    const marked = await s.caller.invoices.markPaid(input)
    expect(await s.caller.invoices.markPaid(input)).toEqual(marked)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: marked.paymentId } })).amount.toFixed(2)).toBe("600.00")
    await expect(s.caller.invoices.undoMarkPaid({ invoiceId: s.invoice.id, paymentId: allocation.id, requestId: randomUUID() })).rejects.toThrow("Reverse this receipt allocation")
    const undo = { invoiceId: s.invoice.id, paymentId: marked.paymentId, requestId: randomUUID() }
    const undone = await s.caller.invoices.undoMarkPaid(undo)
    expect(await s.caller.invoices.undoMarkPaid(undo)).toEqual(undone)
    expect(undone.balance.amount).toBe("600.00")
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: allocation.id } })).toEqual(allocation)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: marked.paymentId } })).voidReason).toBe("Fortrudt")
    const returned = await s.record({ ...bank.input, requestId: randomUUID(), eventReference: randomUUID(), state: "returned", reversesEvidenceId: bank.evidenceId })
    await s.act(s.decision({ action: "return", evidenceId: returned.evidenceId, receiptId: receipt.receiptId }))
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } })).amountPaid.toFixed(2)).toBe("0.00")
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: allocation.id } })).voidedAt).not.toBeNull()
    expect(await s.caller.invoices.markPaid(input)).toEqual(marked)
    expect(await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId } })).toBe(1)
  })

  it.each(["manual_first", "bank_first"])(
    "preserves one receipt, fee and debt in %s arrival order",
    async (order) => {
      const s = await setup()
      const manual = order === "manual_first" ? await s.manual("985", "15") : null
      const bank = await s.record({ netAmount: "985", feeAmount: "15", feeEvidence: evidence })
      const receipt = manual ?? (await s.confirm(bank))
      if (manual) await s.match(bank.evidenceId, manual.receiptId, bank.input.transactionReference)
      await s.allocate(receipt.receiptId, "750")
      const view = await s.caller.payments.receipts({ invoiceId: s.invoice.id })
      expect(view.receipts).toHaveLength(1)
      expect(view.receipts[0]).toMatchObject({
        net: "985.00",
        fee: "15.00",
        gross: "1000.00",
        available: "250.00",
        provenance: { state: "verified", verifiedBy: `user:${s.org.actors.admin.userId}` },
      })
      expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(250)
    },
  )

  it("keeps customer reports and bounded processing evidence out of confirmed cash", async () => {
    const s = await setup()
    const report = await s.record({ source: "client", state: "reported" })
    await expect(s.confirm(report)).rejects.toThrow("Only current received")
    await expect(s.record({ source: "client", state: "received" })).rejects.toThrow()
    const at = new Date()
    const processing = await s.record({
      state: "processing",
      occurredAt: new Date(at.getTime() - 60_000).toISOString(),
    })
    await expect(s.confirm(processing)).rejects.toThrow("Only current received")
    const first = await settlementProvenanceHistory(prisma, s.org.organizationId, s.contact.id, at)
    const deadline = first.find((row) => row.id === processing.sourceId)!.processingReviewUntil
    expect(deadline).toBe(
      new Date(at.getTime() - 60_000 + PROCESSING_REVIEW_WINDOW_MS).toISOString(),
    )
    await s.record({
      ...processing.input,
      requestId: randomUUID(),
      eventReference: randomUUID(),
      occurredAt: at.toISOString(),
    })
    const replayed = await settlementProvenanceHistory(
      prisma,
      s.org.organizationId,
      s.contact.id,
      at,
    )
    expect(replayed.find((row) => row.id === processing.sourceId)).toMatchObject({
      processingReviewUntil: deadline,
      automaticCollectionSuppression: false,
    })
    const expired = await settlementProvenanceHistory(
      prisma,
      s.org.organizationId,
      s.contact.id,
      new Date(at.getTime() + PROCESSING_REVIEW_WINDOW_MS),
    )
    expect(expired.find((row) => row.id === processing.sourceId)?.processingReviewUntil).toBeNull()
    expect(
      await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId } }),
    ).toBe(0)
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(1000)
  })

  it("never merges equal values without an explicit identity and preserves unmatched sources", async () => {
    const s = await setup()
    const one = await s.record()
    const two = await s.record({ source: "provider" })
    const receipt = await s.confirm(one)
    expect(
      (await s.caller.payments.evidenceHistory({ contactId: s.contact.id })).find(
        (row) => row.id === two.sourceId,
      )?.receiptId,
    ).toBeNull()
    await expect(
      s.match(two.evidenceId, receipt.receiptId, one.input.transactionReference),
    ).rejects.toThrow("identity must name")
    await expect(
      s.caller.payments.previewEvidenceDecision({
        action: "match",
        evidenceId: two.evidenceId,
        receiptId: receipt.receiptId,
        requestId: randomUUID(),
        ...evidence,
      } as never),
    ).rejects.toThrow()
    await s.match(two.evidenceId, receipt.receiptId, two.input.transactionReference)
    expect(
      await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId } }),
    ).toBe(1)
  })

  it.each(["bank", "provider"] as const)(
    "deduplicates concurrent %s imports and separate events for one transaction",
    async (source) => {
      const s = await setup()
      const input = s.facts({ source })
      const outcomes = await Promise.all(
        [s.org.actors.admin, s.org.actors.member].map((actor) =>
          executeCommand(
            recordSettlementEvidence,
            { ...input, requestId: randomUUID() },
            { actor },
          ),
        ),
      )
      expect(outcomes.every((outcome) => outcome.status === "completed")).toBe(true)
      const rows = await prisma.settlementEvidence.findMany({
        where: { source: { organizationId: s.org.organizationId } },
      })
      expect(rows).toHaveLength(1)
      await expect(
        s.record({ ...input, requestId: randomUUID(), netAmount: "999" }),
      ).rejects.toThrow("different facts")
      await expect(
        s.record({ ...input, requestId: randomUUID(), transactionReference: randomUUID() }),
      ).rejects.toThrow("different facts")
      const next = await s.record({
        ...input,
        requestId: randomUUID(),
        eventReference: randomUUID(),
      })
      const receipt = await s.confirm(next)
      await expect(s.confirm({ input, evidenceId: rows[0]!.id })).rejects.toThrow(
        "already has a receipt",
      )
      expect(
        await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId } }),
      ).toBe(1)
      const unmatch = s.decision({
        action: "unmatch",
        evidenceId: next.evidenceId,
        receiptId: receipt.receiptId,
      } as SettlementEvidenceDecision)
      await s.act(unmatch)
      await expect(s.confirm(next)).rejects.toThrow("already created or verified a receipt")
      await s.match(next.evidenceId, receipt.receiptId, input.transactionReference)
    },
  )

  it("unmatches verification without erasing cash, preserves corrections, and rejects altered history", async () => {
    const s = await setup()
    const receipt = await s.manual("1200")
    const observation = await s.record({ netAmount: "1200" })
    await s.match(observation.evidenceId, receipt.receiptId, observation.input.transactionReference)
    await s.allocate(receipt.receiptId, "1000")
    await s.act(
      s.decision({
        action: "unmatch",
        evidenceId: observation.evidenceId,
        receiptId: receipt.receiptId,
      } as SettlementEvidenceDecision),
    )
    const view = await s.caller.payments.receipts({ invoiceId: s.invoice.id })
    expect(view.receipts[0]).toMatchObject({
      available: "200.00",
      provenance: { state: "received", verifiedBy: null },
    })
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(0)
    await expect(s.confirm(observation)).rejects.toThrow("already created or verified a receipt")
    const corrected = await s.record({
      ...observation.input,
      requestId: randomUUID(),
      eventReference: randomUUID(),
      netAmount: "1199",
      correctsEvidenceId: observation.evidenceId,
    })
    await expect(
      s.match(observation.evidenceId, receipt.receiptId, observation.input.transactionReference),
    ).rejects.toThrow("Only current received")
    await expect(
      s.match(corrected.evidenceId, receipt.receiptId, observation.input.transactionReference),
    ).rejects.toThrow("must each match")
    const history = await s.caller.payments.evidenceHistory({ contactId: s.contact.id })
    expect(history[0]!.observations).toHaveLength(2)
    expect(history[0]!.observations[1]).toMatchObject({
      correctsEvidenceId: observation.evidenceId,
      actorKey: `user:${s.org.actors.admin.userId}`,
    })
    expect(history[0]!.decisions.map((row) => row.action)).toEqual(["match", "unmatch"])
    await expect(
      prisma.settlementEvidence.update({
        where: { id: observation.evidenceId },
        data: { netAmount: "50" },
      }),
    ).rejects.toThrow("immutable")
    await expect(
      prisma.settlementEvidenceDecision.update({
        where: { id: history[0]!.decisions[0]!.id },
        data: { reason: "overwrite" },
      }),
    ).rejects.toThrow("immutable")
  })

  it("checks net and fee independently and reverses frozen foreign-currency debt after a late return", async () => {
    const s = await setup()
    const receipt = await s.manual("98", "2", "EUR")
    const wrong = await s.record({
      currency: "EUR",
      netAmount: "99",
      feeAmount: "1",
      feeEvidence: evidence,
    })
    await expect(
      s.match(wrong.evidenceId, receipt.receiptId, wrong.input.transactionReference),
    ).rejects.toThrow("must each match")
    const source = await s.record({
      currency: "EUR",
      netAmount: "98",
      feeAmount: "2",
      feeEvidence: evidence,
    })
    await s.match(source.evidenceId, receipt.receiptId, source.input.transactionReference)
    await s.allocate(receipt.receiptId, "80", "596")
    const returned = await s.record({
      ...source.input,
      requestId: randomUUID(),
      eventReference: randomUUID(),
      state: "returned",
      reversesEvidenceId: source.evidenceId,
      occurredAt: "2026-02-15T12:00:00.000Z",
    })
    const input = s.decision({
      action: "return",
      evidenceId: returned.evidenceId,
      receiptId: receipt.receiptId,
    } as SettlementEvidenceDecision)
    const preview = await s.caller.payments.previewEvidenceDecision(input)
    expect(preview).toMatchObject({
      cashChange: "-98.00",
      availableBefore: "20.00",
      availableAfter: "0.00",
      invoices: [{ invoiceId: s.invoice.id, currency: "DKK", before: "404.00", after: "1000.00" }],
      allocations: [{ receiptAmount: "80.00", invoiceAmount: "596.00" }],
    })
    const result = await s.caller.payments.decideEvidence({
      decision: input,
      previewToken: preview.previewToken,
    })
    expect(
      await s.caller.payments.decideEvidence({
        decision: input,
        previewToken: preview.previewToken,
      }),
    ).toEqual(result)
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(1000)
    const view = await s.caller.payments.receipts({ invoiceId: s.invoice.id })
    expect(view.receipts[0]).toMatchObject({
      net: "98.00",
      fee: "2.00",
      reversed: true,
      available: "0.00",
      provenance: { state: "returned" },
    })
    const reversals = view.receipts[0]!.history.filter((row) => row.type === "settlement.changed")
    expect(reversals.map((row) => (row.payload as { action: string }).action)).toEqual([
      "reverse_allocation",
      "reverse_receipt",
    ])
    const late = await s.record({
      ...source.input,
      requestId: randomUUID(),
      eventReference: randomUUID(),
      state: "processing",
    })
    expect(
      (await s.caller.payments.evidenceHistory({ contactId: s.contact.id })).find(
        (row) => row.id === late.sourceId,
      )?.state,
    ).toBe("returned")
    await expect(s.confirm(source)).rejects.toThrow()
  })

  it("serializes competing matches and rejects stale return previews after a new allocation", async () => {
    const s = await setup()
    const source = await s.record()
    const receipts = [await s.manual(), await s.manual()]
    const inputs = receipts.map((row) =>
      s.decision({
        action: "match",
        receiptId: row.receiptId,
        evidenceId: source.evidenceId,
        identity: s.identity(source.input.transactionReference),
      } as SettlementEvidenceDecision),
    )
    const previews = await Promise.all(
      inputs.map((input) => s.caller.payments.previewEvidenceDecision(input)),
    )
    const outcomes = await Promise.all(
      inputs.map((input, i) =>
        executeCommand(
          decideSettlementEvidence,
          { decision: input, previewToken: previews[i]!.previewToken },
          { actor: s.org.actors.admin, clientRequestId: input.requestId },
        ),
      ),
    )
    expect(outcomes.filter((row) => row.status === "completed")).toHaveLength(1)
    const winner = receipts[outcomes.findIndex((row) => row.status === "completed")]!.receiptId
    const returned = await s.record({
      ...source.input,
      requestId: randomUUID(),
      eventReference: randomUUID(),
      state: "returned",
      reversesEvidenceId: source.evidenceId,
    })
    const change = s.decision({
      action: "return",
      receiptId: winner,
      evidenceId: returned.evidenceId,
    } as SettlementEvidenceDecision)
    const preview = await s.caller.payments.previewEvidenceDecision(change)
    await s.allocate(winner, "600")
    await expect(
      s.caller.payments.decideEvidence({ decision: change, previewToken: preview.previewToken }),
    ).rejects.toThrow("changed")
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(400)
    await s.act({ ...change, requestId: randomUUID() })
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(1000)
  })

  it("enforces tenant, current membership, correction roles, and person-only decisions", async () => {
    const s = await setup()
    const other = await setup()
    const source = await s.record()
    const receipt = await s.confirm(source)
    const member = callerFor(s.org.organizationId, s.org.actors.member.userId)
    const accountant = callerFor(s.org.organizationId, s.org.actors.accountant.userId)
    expect(await other.caller.payments.evidenceHistory({ contactId: s.contact.id })).toEqual([])
    await expect(
      other.caller.payments.previewEvidenceDecision(
        s.decision({
          action: "match",
          receiptId: receipt.receiptId,
          evidenceId: source.evidenceId,
          identity: s.identity(source.input.transactionReference),
        } as SettlementEvidenceDecision),
      ),
    ).rejects.toThrow("Evidence not found")
    const unmatch = s.decision({
      action: "unmatch",
      receiptId: receipt.receiptId,
      evidenceId: source.evidenceId,
    } as SettlementEvidenceDecision)
    const preview = await s.caller.payments.previewEvidenceDecision(unmatch)
    await expect(
      member.payments.decideEvidence({ decision: unmatch, previewToken: preview.previewToken }),
    ).rejects.toThrow("payment:void")
    await expect(accountant.payments.recordEvidence(s.facts())).rejects.toThrow()
    const agent = {
      kind: "agent" as const,
      organizationId: s.org.organizationId,
      agentKeyId: "fixture-agent",
      label: "Fixture",
      mode: "approval_required" as const,
      ownerRoles: s.org.actors.admin.roles,
      scopes: ["payment:create" as const],
    }
    expect(
      await executeCommand(recordSettlementEvidence, s.facts(), { actor: agent }),
    ).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    expect(
      await executeCommand(recordSettlementEvidence, s.facts(), {
        actor: {
          kind: "system",
          organizationId: s.org.organizationId,
          reason: "customer_link",
          label: "Customer",
        },
      }),
    ).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    await prisma.member.update({
      where: {
        organizationId_userId: {
          organizationId: s.org.organizationId,
          userId: s.org.actors.admin.userId,
        },
      },
      data: { role: "accountant" },
    })
    expect(
      await executeCommand(recordSettlementEvidence, s.facts(), { actor: s.org.actors.admin }),
    ).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
  })
  it("replaces source-created cash only after reversal, unmatching and an explicit correction", async () => {
    const s = await setup()
    const original = await s.record()
    const first = await s.confirm(original)
    const correction = {
      ...original.input,
      requestId: randomUUID(),
      eventReference: randomUUID(),
      netAmount: "900",
      correctsEvidenceId: original.evidenceId,
    }
    await expect(s.caller.payments.recordEvidence(correction)).rejects.toThrow("Unmatch")
    const change = {
      requestId: randomUUID(),
      action: "reverse_receipt" as const,
      receiptId: first.receiptId,
      ...evidence,
    }
    const preview = await s.caller.payments.previewReceiptChange(change)
    await s.caller.payments.changeReceipt({ ...change, previewToken: preview.previewToken })
    await s.act(
      s.decision({
        action: "unmatch",
        evidenceId: original.evidenceId,
        receiptId: first.receiptId,
      } as SettlementEvidenceDecision),
    )
    const corrected = await s.record({ ...correction, requestId: randomUUID() })
    const second = await s.confirm(corrected)
    expect(second.receiptId).not.toBe(first.receiptId)
    const receipts = await prisma.settlementReceipt.findMany({
      where: { organizationId: s.org.organizationId },
    })
    expect(receipts).toHaveLength(2)
    expect(
      receipts.filter((row) => !row.reversedAt).map((row) => row.netAmount.toFixed(2)),
    ).toEqual(["900.00"])
    expect(
      (await s.caller.payments.evidenceHistory({ contactId: s.contact.id }))[0]!.observations[0]!
        .netAmount,
    ).toBe("1000.00")
  })

  it("returns only the linked receipt's debt while retaining other receipts and refunds", async () => {
    const s = await setup()
    const original = await s.record({ netAmount: "700" })
    const receipt = await s.confirm(original)
    const independent = await s.manual("400")
    await s.allocate(receipt.receiptId, "600")
    await s.allocate(independent.receiptId, "400")
    const refund = {
      requestId: randomUUID(),
      action: "refund" as const,
      receiptId: receipt.receiptId,
      amount: "100",
      ...evidence,
    }
    const preview = await s.caller.payments.previewReceiptChange(refund)
    const refunded = await s.caller.payments.changeReceipt({
      ...refund,
      previewToken: preview.previewToken,
    })
    const returned = await s.record({
      ...original.input,
      requestId: randomUUID(),
      eventReference: randomUUID(),
      state: "returned",
      reversesEvidenceId: original.evidenceId,
    })
    const decision = s.decision({
      action: "return",
      evidenceId: returned.evidenceId,
      receiptId: receipt.receiptId,
    } as SettlementEvidenceDecision)
    await expect(s.act(decision)).rejects.toThrow("Resolve recorded refunds")
    const reverse = {
      requestId: randomUUID(),
      action: "reverse_refund" as const,
      refundId: refunded.targetId,
      ...evidence,
    }
    const refundPreview = await s.caller.payments.previewReceiptChange(reverse)
    await s.caller.payments.changeReceipt({ ...reverse, previewToken: refundPreview.previewToken })
    await s.act({ ...decision, requestId: randomUUID() })
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(600)
    expect(
      await prisma.payment.count({ where: { receiptId: independent.receiptId, voidedAt: null } }),
    ).toBe(1)
    expect(await prisma.settlementRefund.count({ where: { receiptId: receipt.receiptId } })).toBe(1)
  })

  it("deduplicates simultaneous confirmations and races a return against allocation atomically", async () => {
    const s = await setup()
    const source = await s.record()
    const input = s.decision({
      action: "confirm",
      evidenceId: source.evidenceId,
      method: "bank_transfer",
      identity: s.identity(source.input.transactionReference),
    } as SettlementEvidenceDecision)
    const preview = await s.caller.payments.previewEvidenceDecision(input)
    const confirmations = await Promise.all(
      [1, 2].map(() =>
        s.caller.payments.decideEvidence({ decision: input, previewToken: preview.previewToken }),
      ),
    )
    expect(confirmations[0]).toEqual(confirmations[1])
    const receiptId = confirmations[0]!.receiptId
    const returned = await s.record({
      ...source.input,
      requestId: randomUUID(),
      eventReference: randomUUID(),
      state: "returned",
      reversesEvidenceId: source.evidenceId,
    })
    const change = s.decision({
      action: "return",
      evidenceId: returned.evidenceId,
      receiptId,
    } as SettlementEvidenceDecision)
    const returnPreview = await s.caller.payments.previewEvidenceDecision(change)
    const allocation = {
      requestId: randomUUID(),
      receiptId,
      allocations: [{ invoiceId: s.invoice.id, receiptAmount: "700", invoiceAmount: "700" }],
      ...evidence,
    }
    const allocationPreview = await s.caller.payments.previewAllocation(allocation)
    const results = await Promise.allSettled([
      s.caller.payments.decideEvidence({
        decision: change,
        previewToken: returnPreview.previewToken,
      }),
      s.caller.payments.allocateReceipt({
        ...allocation,
        previewToken: allocationPreview.previewToken,
      }),
    ])
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1)
    if (results[0]!.status === "rejected") await s.act({ ...change, requestId: randomUUID() })
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(1000)
    expect(await prisma.payment.count({ where: { receiptId, voidedAt: null } })).toBe(0)
    expect(
      await prisma.settlementEvidenceDecision.count({ where: { receiptId, action: "return" } }),
    ).toBe(1)
  })

  it("refuses invalid precision, unrelated return references, and legacy provider duplication", async () => {
    const s = await setup()
    await expect(s.record({ currency: "JPY", netAmount: "0.01" })).rejects.toThrow("exact JPY")
    await expect(s.record({ currency: "KWD", netAmount: "1" })).rejects.toThrow(
      "Unsupported currency",
    )
    await expect(s.record({ feeAmount: "1" })).rejects.toThrow("Fee evidence")
    const source = await s.record({ source: "provider", transactionReference: "pi_existing" })
    const other = await s.record()
    await expect(
      s.record({
        ...source.input,
        requestId: randomUUID(),
        eventReference: randomUUID(),
        state: "returned",
        reversesEvidenceId: other.evidenceId,
      }),
    ).rejects.toThrow("this transaction")
    await expect(
      s.record({
        ...source.input,
        requestId: randomUUID(),
        eventReference: randomUUID(),
        state: "returned",
        reversesEvidenceId: source.evidenceId,
        netAmount: "500",
      }),
    ).rejects.toThrow("full return")
    const legacy = await s.caller.payments.record({
      invoiceId: s.invoice.id,
      amount: 1000,
      paidAt: "2026-01-15",
      method: "stripe",
    })
    // Model an existing webhook-owned payment without connecting a provider or changing its flow.
    await prisma.payment.update({
      where: { id: legacy.payment.id },
      data: { stripePaymentIntentId: "pi_existing", source: "stripe" },
    })
    await expect(s.confirm(source)).rejects.toThrow("legacy payment")
    expect(
      await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId } }),
    ).toBe(0)
  })
  it("applies a return received before manual matching only with explicit identity and reads consistent totals", async () => {
    const s = await setup()
    const receipt = await s.manual()
    await s.allocate(receipt.receiptId, "1000")
    const received = await s.record()
    const returned = await s.record({
      ...received.input,
      requestId: randomUUID(),
      eventReference: randomUUID(),
      state: "returned",
      reversesEvidenceId: received.evidenceId,
    })
    const missing = s.decision({
      action: "return",
      receiptId: receipt.receiptId,
      evidenceId: returned.evidenceId,
    } as SettlementEvidenceDecision)
    await expect(s.act(missing)).rejects.toThrow("explicit receipt identity")
    const change: SettlementEvidenceDecision = {
      ...missing,
      action: "return",
      receiptId: receipt.receiptId,
      identity: s.identity(received.input.transactionReference),
    }
    const preview = await s.caller.payments.previewEvidenceDecision(change)
    const [, snapshot] = await Promise.all([
      s.caller.payments.decideEvidence({ decision: change, previewToken: preview.previewToken }),
      s.caller.payments.receipts({ invoiceId: s.invoice.id }),
    ])
    const row = snapshot.receipts[0]!
    if (row.reversed) {
      expect(row.provenance.state).toBe("returned")
      expect(snapshot.invoices[0]!.balanceDue).toBe("1000.00")
      expect(row.allocated).toBe("0.00")
    } else {
      expect(row.provenance.state).toBe("received")
      expect(snapshot.invoices[0]!.balanceDue).toBe("0.00")
      expect(row.allocated).toBe("1000.00")
    }
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(1000)
    expect(
      (await s.caller.payments.evidenceHistory({ contactId: s.contact.id }))[0]!.decisions[0]!
        .identity,
    ).toEqual(change.identity)
  })

  async function reverse(s: Awaited<ReturnType<typeof setup>>, receiptId: string) {
    const change = { requestId: randomUUID(), action: "reverse_receipt" as const, receiptId, ...evidence }
    const preview = await s.caller.payments.previewReceiptChange(change)
    await s.caller.payments.changeReceipt({ ...change, previewToken: preview.previewToken })
  }
  async function unmatch(s: Awaited<ReturnType<typeof setup>>, evidenceId: string, receiptId: string) {
    await s.act(s.decision({ action: "unmatch", evidenceId, receiptId }))
  }
  async function correct(s: Awaited<ReturnType<typeof setup>>, original: Awaited<ReturnType<typeof s.record>>) {
    return s.record({
      ...original.input, requestId: randomUUID(), eventReference: randomUUID(),
      netAmount: "900", correctsEvidenceId: original.evidenceId,
    })
  }

  it.each(["bank", "provider"])("round 2: shares corrected replacement identity when %s confirms first", async (first) => {
    const s = await setup(2000)
    const bank = await s.record()
    const provider = await s.record({ source: "provider" })
    const original = await s.confirm(bank)
    await s.match(provider.evidenceId, original.receiptId, provider.input.transactionReference)
    await reverse(s, original.receiptId)
    await unmatch(s, bank.evidenceId, original.receiptId)
    await unmatch(s, provider.evidenceId, original.receiptId)
    const a = await correct(s, bank)
    const b = await correct(s, provider)
    const [winner, loser] = first === "bank" ? [a, b] : [b, a]
    const input = s.decision({ action: "confirm", evidenceId: loser.evidenceId,
      method: "bank_transfer", identity: s.identity(loser.input.transactionReference) })
    const preview = await s.caller.payments.previewEvidenceDecision(input)
    const replacement = await s.confirm(winner)
    const [result] = await Promise.allSettled([
      s.caller.payments.decideEvidence({ decision: input, previewToken: preview.previewToken }),
    ])
    await s.allocate(replacement.receiptId, "900")
    if (result.status === "fulfilled") await s.allocate(result.value.receiptId, "900")
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(1100)
    expect(result.status).toBe("rejected")
    await expect(s.confirm(loser)).rejects.toThrow("replacement")
    await s.match(loser.evidenceId, replacement.receiptId, loser.input.transactionReference)
    const active = await prisma.settlementReceipt.findMany({
      where: { organizationId: s.org.organizationId, reversedAt: null },
    })
    expect(active.map(row => row.netAmount.toFixed(2))).toEqual(["900.00"])
    expect(await prisma.settlementEvidenceSource.count({ where: { receiptId: replacement.receiptId } })).toBe(2)
  })

  it.each([
    ["evidence_first", "session"], ["webhook_first", "session"],
    ["evidence_first", "intent"], ["webhook_first", "intent"],
  ])("round 2: protects known Stripe %s / %s identity through actual commands", async (order, reference) => {
    const s = await setup()
    const checkoutSessionId = `cs_${randomUUID()}`
    const paymentIntentId = `pi_${randomUUID()}`
    await prisma.invoice.update({ where: { id: s.invoice.id }, data: { stripeCheckoutSessionId: checkoutSessionId, stripePaymentIntentId: paymentIntentId } })
    const second = await s.caller.invoices.create({ contactId: s.contact.id, currency: "DKK", taxRate: 0,
      dueDate: "2099-01-01", items: [{ description: "Other work", quantity: 1, unitPrice: 1000 }] })
    await s.caller.invoices.send({ id: second.id, allowSendWithoutEmail: true })
    const observed = await s.record({ source: "provider", transactionReference: reference === "session" ? checkoutSessionId : paymentIntentId })
    const webhook = () => executeCommand(recordStripeCheckoutPayment, {
      invoiceId: s.invoice.id, checkoutSessionId, paymentIntentId, amount: 1000,
      currency: "DKK", paidAt: "2026-01-15T12:00:00.000Z",
    }, { actor: { kind: "system", organizationId: s.org.organizationId, reason: "stripe_webhook", label: "Synthetic checkout command" } })
    if (order === "webhook_first") expect(await webhook()).toMatchObject({ status: "completed", result: { alreadyApplied: false } })
    const [confirmation] = await Promise.allSettled([s.confirm(observed)])
    if (order === "evidence_first") expect(await webhook()).toMatchObject({ status: "completed", result: { alreadyApplied: false } })
    if (confirmation.status === "fulfilled") {
      const allocation = { requestId: randomUUID(), receiptId: confirmation.value.receiptId,
        allocations: [{ invoiceId: second.id, receiptAmount: "1000", invoiceAmount: "1000" }], ...evidence }
      const preview = await s.caller.payments.previewAllocation(allocation)
      await s.caller.payments.allocateReceipt({ ...allocation, previewToken: preview.previewToken })
    }
    expect((await s.caller.payments.list({ invoiceId: second.id })).balanceDue).toBe(1000)
    expect(confirmation.status).toBe("rejected")
    expect(await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId } })).toBe(0)
    expect(await prisma.payment.count({ where: { organizationId: s.org.organizationId } })).toBe(1)
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(0)
    expect(await webhook()).toMatchObject({ status: "completed", result: { alreadyApplied: true } })
  })

  it("round 2: applies a late return to a corrected manual replacement after unmatching", async () => {
    const s = await setup()
    const original = await s.record()
    const first = await s.confirm(original)
    await reverse(s, first.receiptId)
    await unmatch(s, original.evidenceId, first.receiptId)
    const corrected = await correct(s, original)
    const replacement = await s.manual("900")
    await s.match(corrected.evidenceId, replacement.receiptId, corrected.input.transactionReference)
    await s.allocate(replacement.receiptId, "900")
    await unmatch(s, corrected.evidenceId, replacement.receiptId)
    const returned = await s.record({ ...corrected.input, requestId: randomUUID(), eventReference: randomUUID(),
      correctsEvidenceId: undefined, state: "returned", reversesEvidenceId: corrected.evidenceId })
    await s.act(s.decision({ action: "return", evidenceId: returned.evidenceId, receiptId: replacement.receiptId,
      identity: s.identity(corrected.input.transactionReference) }))
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(1000)
    const history = (await s.caller.payments.evidenceHistory({ contactId: s.contact.id }))[0]!
    expect(history.createdReceiptId).toBe(first.receiptId)
    expect(history.receiptId).toBe(replacement.receiptId)
    expect(history.decisions.map(row => [row.action, row.receiptId])).toEqual([
      ["confirm", first.receiptId], ["unmatch", first.receiptId], ["match", replacement.receiptId],
      ["unmatch", replacement.receiptId], ["return", replacement.receiptId],
    ])
    expect(await prisma.payment.count({ where: { receiptId: replacement.receiptId, voidedAt: null } })).toBe(0)
    expect(await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId, reversedAt: null } })).toBe(0)
  })

  it.each(["reported", "processing"] as const)("round 2: refuses deletion of an evidence-only %s contact with contact_in_use", async state => {
    const s = await setup()
    const contact = await s.caller.contacts.create({ name: "Evidence only" })
    const observation = await s.record({ contactId: contact.id, state })
    expect(await prisma.invoice.count({ where: { contactId: contact.id } })).toBe(0)
    expect(await prisma.settlementReceipt.count({ where: { contactId: contact.id } })).toBe(0)
    const outcome = await executeCommand(deleteContact, { id: contact.id }, { actor: s.org.actors.admin })
    expect(outcome).toMatchObject({ status: "failed", error: { tag: "InvalidState", code: "contact_in_use" } })
    expect(await prisma.contact.findUnique({ where: { id: contact.id } })).not.toBeNull()
    expect(await prisma.settlementEvidence.findUnique({ where: { id: observation.evidenceId } })).not.toBeNull()
  })


  it("round 2: explicitly rejects a mistaken past match without detaching source-created cash", async () => {
    const s = await setup(2000)
    const bank = await s.record()
    const provider = await s.record({ source: "provider" })
    const first = await s.confirm(bank)
    await s.match(provider.evidenceId, first.receiptId, provider.input.transactionReference)
    await unmatch(s, provider.evidenceId, first.receiptId)
    const corrected = await correct(s, provider)
    await expect(s.confirm(corrected)).rejects.toThrow("replacement")
    const reject = s.decision({ action: "reject_match", evidenceId: provider.evidenceId, receiptId: first.receiptId,
      reason: "The provider transfer is a different transaction; the old match was mistaken",
      evidence: "https://evidence.example.test/corrected-identity" })
    const preview = await s.caller.payments.previewEvidenceDecision(reject)
    expect(preview.cashChange).toBe("0.00")
    const member = callerFor(s.org.organizationId, s.org.actors.member.userId)
    await expect(member.payments.decideEvidence({ decision: reject, previewToken: preview.previewToken })).rejects.toThrow("payment:void")
    await s.caller.payments.decideEvidence({ decision: reject, previewToken: preview.previewToken })
    const second = await s.confirm(corrected)
    await s.allocate(first.receiptId, "1000")
    await s.allocate(second.receiptId, "900")
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(100)
    const history = (await s.caller.payments.evidenceHistory({ contactId: s.contact.id })).find(row => row.id === provider.sourceId)!
    expect(history.decisions.map(row => row.action)).toEqual(["match", "unmatch", "reject_match", "confirm"])
    expect(history.decisions[2]).toMatchObject({ reason: reject.reason, evidence: reject.evidence, receiptId: first.receiptId })
    await unmatch(s, bank.evidenceId, first.receiptId)
    await expect(s.act(s.decision({ action: "reject_match", evidenceId: bank.evidenceId, receiptId: first.receiptId }))).rejects.toThrow("Source-created cash")
    await s.match(bank.evidenceId, first.receiptId, bank.input.transactionReference)
  })

  it("round 2: binds related source revisions and serializes competing replacement confirmations", async () => {
    const s = await setup()
    const a = await s.record()
    const b = await s.record({ source: "provider" })
    const original = await s.confirm(a)
    await s.match(b.evidenceId, original.receiptId, b.input.transactionReference)
    await reverse(s, original.receiptId)
    await unmatch(s, a.evidenceId, original.receiptId)
    await unmatch(s, b.evidenceId, original.receiptId)
    const correctedA = await correct(s, a)
    const correctedB = await correct(s, b)
    const decisionA = s.decision({ action: "confirm", evidenceId: correctedA.evidenceId, method: "bank_transfer", identity: s.identity(a.input.transactionReference) })
    const oldPreview = await s.caller.payments.previewEvidenceDecision(decisionA)
    // Same quantities, but a related operator decision now needs to be reviewed.
    const nextB = await correct(s, correctedB)
    const newPreview = await s.caller.payments.previewEvidenceDecision(decisionA)
    expect(newPreview.previewToken).not.toBe(oldPreview.previewToken)
    await expect(s.caller.payments.decideEvidence({ decision: decisionA, previewToken: oldPreview.previewToken })).rejects.toThrow("changed")
    const freshA = { ...decisionA, requestId: randomUUID() }
    const decisionB = s.decision({ action: "confirm", evidenceId: nextB.evidenceId, method: "bank_transfer", identity: s.identity(b.input.transactionReference) })
    const [previewA, previewB] = await Promise.all([
      s.caller.payments.previewEvidenceDecision(freshA), s.caller.payments.previewEvidenceDecision(decisionB),
    ])
    const outcomes = await Promise.allSettled([
      s.caller.payments.decideEvidence({ decision: freshA, previewToken: previewA.previewToken }),
      s.caller.payments.decideEvidence({ decision: decisionB, previewToken: previewB.previewToken }),
    ])
    expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1)
    expect(await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId, reversedAt: null } })).toBe(1)
  })

  it("round 2: recovers mistaken shared identity after reversal and another source's replacement", async () => {
    const s = await setup(2000)
    const bank = await s.record()
    const provider = await s.record({ source: "provider" })
    const original = await s.confirm(bank)
    await s.match(provider.evidenceId, original.receiptId, provider.input.transactionReference)
    await reverse(s, original.receiptId)
    await unmatch(s, bank.evidenceId, original.receiptId)
    await unmatch(s, provider.evidenceId, original.receiptId)
    const correctedBank = await correct(s, bank)
    const correctedProvider = await correct(s, provider)
    const bankReplacement = await s.confirm(correctedBank)
    await expect(s.confirm(correctedProvider)).rejects.toThrow(bankReplacement.receiptId)
    await s.act(s.decision({
      action: "reject_match",
      evidenceId: provider.evidenceId,
      receiptId: original.receiptId,
      reason: "The original provider match joined two different receipts",
      evidence: "https://evidence.example.test/two-distinct-receipts",
    }))
    const providerReceipt = await s.confirm(correctedProvider)
    expect(providerReceipt.receiptId).not.toBe(bankReplacement.receiptId)
    await s.allocate(bankReplacement.receiptId, "900")
    await s.allocate(providerReceipt.receiptId, "900")
    expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(200)
    const history = await s.caller.payments.evidenceHistory({ contactId: s.contact.id })
    expect(history.find((row) => row.id === bank.sourceId)?.receiptId).toBe(bankReplacement.receiptId)
    const providerHistory = history.find((row) => row.id === provider.sourceId)!
    expect(providerHistory.receiptId).toBe(providerReceipt.receiptId)
    expect(providerHistory.decisions.map((row) => row.action)).toEqual([
      "match", "unmatch", "reject_match", "confirm",
    ])
  })

  it.each(["unmatched", "still_matched"])(
    "round 3: recovers the mistaken receipt when return arrives %s",
    async (order) => {
      const s = await setup()
      const second = await s.caller.invoices.create({
        contactId: s.contact.id, currency: "DKK", taxRate: 0, dueDate: "2099-01-01",
        items: [{ description: "Separate work", quantity: 1, unitPrice: 1000 }],
      })
      await s.caller.invoices.send({ id: second.id, allowSendWithoutEmail: true })
      const wrong = await s.manual()
      const right = await s.manual()
      await s.allocate(wrong.receiptId, "1000")
      const allocation = {
        requestId: randomUUID(), receiptId: right.receiptId,
        allocations: [{ invoiceId: second.id, receiptAmount: "1000", invoiceAmount: "1000" }],
        ...evidence,
      }
      const allocationPreview = await s.caller.payments.previewAllocation(allocation)
      await s.caller.payments.allocateReceipt({ ...allocation, previewToken: allocationPreview.previewToken })
      const wrongRows = async () => ({
        receipt: await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: wrong.receiptId } }),
        invoice: await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } }),
        payments: await prisma.payment.findMany({ where: { receiptId: wrong.receiptId } }),
      })
      const before = await wrongRows()
      const bank = await s.record()
      await s.match(bank.evidenceId, wrong.receiptId, bank.input.transactionReference)
      const originalMatch = await prisma.settlementEvidenceDecision.findFirstOrThrow({ where: { sourceId: bank.sourceId, action: "match" } })
      if (order === "unmatched") await unmatch(s, bank.evidenceId, wrong.receiptId)
      const returned = await s.record({
        ...bank.input, requestId: randomUUID(), eventReference: randomUUID(),
        state: "returned", reversesEvidenceId: bank.evidenceId,
      })
      const wrongReturn = s.decision({
        action: "return", evidenceId: returned.evidenceId, receiptId: wrong.receiptId,
        identity: s.identity(bank.input.transactionReference),
      })
      const oldReturn = await s.caller.payments.previewEvidenceDecision(wrongReturn)
      const reject = s.decision({
        action: "reject_match", evidenceId: bank.evidenceId, receiptId: wrong.receiptId,
        reason: "The original match used the wrong manual receipt; the bank reference belongs to the second transfer",
        evidence: "https://evidence.example.test/correct-transfer-identity",
      })
      const preview = await s.caller.payments.previewEvidenceDecision(reject)
      expect(preview.cashChange).toBe("0.00")
      expect(preview.invoices).toEqual([{ invoiceId: s.invoice.id, currency: "DKK", before: "0.00", after: "0.00" }])
      expect(preview.unmatchesReceiptId).toBe(order === "still_matched" ? wrong.receiptId : null)
      const rejected = await s.caller.payments.decideEvidence({ decision: reject, previewToken: preview.previewToken })
      expect(await s.caller.payments.decideEvidence({ decision: reject, previewToken: preview.previewToken })).toEqual(rejected)
      expect(await wrongRows()).toEqual(before)
      expect((await s.caller.payments.list({ invoiceId: second.id })).balanceDue).toBe(0)
      const history = (await s.caller.payments.evidenceHistory({ contactId: s.contact.id }))[0]!
      expect(history).toMatchObject({ state: "returned", receiptId: null, createdReceiptId: null })
      expect(history.decisions.at(-1)).toMatchObject({
        action: "reject_match", evidenceId: bank.evidenceId, receiptId: wrong.receiptId,
        reason: reject.reason, evidence: reject.evidence, actorKey: `user:${s.org.actors.admin.userId}`,
      })
      expect(history.decisions.map(row => row.action)).toEqual(["match", "unmatch", "reject_match"])
      if (order === "still_matched") {
        expect(history.decisions[1]!.commandId).toBe(history.decisions[2]!.commandId)
        expect(history.decisions[1]).toMatchObject({ reason: reject.reason, evidence: reject.evidence })
        const events = await prisma.domainEvent.findMany({ where: { commandId: history.decisions[2]!.commandId }, orderBy: { sequence: "asc" } })
        expect(events.map(row => row.payload)).toEqual([
          expect.objectContaining({ action: "unmatch", receiptId: wrong.receiptId }),
          expect.objectContaining({ action: "reject_match", receiptId: wrong.receiptId }),
        ])
      }
      expect(await prisma.settlementEvidenceDecision.findUnique({ where: { id: originalMatch.id } })).toEqual(originalMatch)
      await expect(s.caller.payments.decideEvidence({ decision: wrongReturn, previewToken: oldReturn.previewToken })).rejects.toThrow("changed")
      await expect(s.confirm(bank)).rejects.toThrow("Returned evidence")
      await expect(s.match(bank.evidenceId, right.receiptId, bank.input.transactionReference)).rejects.toThrow("Returned evidence")
      await s.act(s.decision({
        action: "return", evidenceId: returned.evidenceId, receiptId: right.receiptId,
        identity: s.identity(bank.input.transactionReference),
      }))
      expect(await wrongRows()).toEqual(before)
      expect((await s.caller.payments.list({ invoiceId: s.invoice.id })).balanceDue).toBe(0)
      expect((await s.caller.payments.list({ invoiceId: second.id })).balanceDue).toBe(1000)
      expect(await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId } })).toBe(2)
      expect(await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: right.receiptId } })).toMatchObject({ reversedAt: expect.any(Date) })
      expect(await prisma.payment.count({ where: { receiptId: right.receiptId, voidedAt: null } })).toBe(0)
      expect(await prisma.settlementEvidenceDecision.count({ where: { sourceId: bank.sourceId, action: "return" } })).toBe(1)
      await expect(s.act({ ...reject, requestId: randomUUID() })).rejects.toThrow("current receipt match")
    },
  )

  it("round 3: requires original match evidence, current void authority, tenant scope and a fresh rejection preview", async () => {
    const s = await setup()
    const other = await setup()
    const bank = await s.record()
    const receipt = await s.manual()
    await s.match(bank.evidenceId, receipt.receiptId, bank.input.transactionReference)
    const returned = await s.record({ ...bank.input, requestId: randomUUID(), eventReference: randomUUID(),
      state: "returned", reversesEvidenceId: bank.evidenceId })
    const reject = s.decision({ action: "reject_match", evidenceId: bank.evidenceId, receiptId: receipt.receiptId })
    const preview = await s.caller.payments.previewEvidenceDecision(reject)
    const before = await prisma.settlementEvidenceDecision.findMany({ where: { sourceId: bank.sourceId } })
    await expect(s.caller.payments.previewEvidenceDecision({ ...reject, reason: "" })).rejects.toThrow()
    await expect(s.caller.payments.previewEvidenceDecision({ ...reject, evidence: "" })).rejects.toThrow()
    await expect(s.caller.payments.previewEvidenceDecision({ ...reject, evidenceId: returned.evidenceId })).rejects.toThrow("established match")
    await expect(other.caller.payments.previewEvidenceDecision(reject)).rejects.toThrow("Evidence not found")
    const otherReceipt = await other.manual()
    await expect(s.caller.payments.previewEvidenceDecision({ ...reject, action: "reject_match", receiptId: otherReceipt.receiptId })).rejects.toThrow("Receipt not found")
    const member = callerFor(s.org.organizationId, s.org.actors.member.userId)
    await expect(member.payments.previewEvidenceDecision(reject)).rejects.toThrow("payment:void")
    await expect(member.payments.decideEvidence({ decision: reject, previewToken: preview.previewToken })).rejects.toThrow("payment:void")
    for (const actor of [
      { kind: "system" as const, organizationId: s.org.organizationId, reason: "customer_link" as const, label: "Customer" },
      { kind: "agent" as const, organizationId: s.org.organizationId, agentKeyId: "fixture-agent", label: "Fixture",
        mode: "full_access" as const, ownerRoles: s.org.actors.admin.roles, scopes: ["payment:create" as const, "payment:void" as const] },
    ]) {
      expect(await executeCommand(decideSettlementEvidence, { decision: reject, previewToken: preview.previewToken }, { actor }))
        .toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    }
    await s.record({ ...bank.input, requestId: randomUUID(), eventReference: randomUUID(),
      state: "returned", reversesEvidenceId: bank.evidenceId })
    await expect(s.caller.payments.decideEvidence({ decision: reject, previewToken: preview.previewToken })).rejects.toThrow("changed")
    const fresh = { ...reject, requestId: randomUUID() }
    const freshPreview = await s.caller.payments.previewEvidenceDecision(fresh)
    await prisma.member.update({ where: { organizationId_userId: {
      organizationId: s.org.organizationId, userId: s.org.actors.admin.userId,
    } }, data: { role: "member" } })
    expect(await executeCommand(decideSettlementEvidence, { decision: fresh, previewToken: freshPreview.previewToken }, { actor: s.org.actors.admin }))
      .toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    await prisma.member.delete({ where: { organizationId_userId: {
      organizationId: s.org.organizationId, userId: s.org.actors.admin.userId,
    } } })
    expect(await executeCommand(decideSettlementEvidence, { decision: { ...fresh, requestId: randomUUID() }, previewToken: freshPreview.previewToken }, { actor: s.org.actors.admin }))
      .toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    expect(await prisma.settlementEvidenceDecision.findMany({ where: { sourceId: bank.sourceId } })).toEqual(before)
    expect(await prisma.settlementEvidenceSource.findUniqueOrThrow({ where: { id: bank.sourceId } })).toMatchObject({ receiptId: receipt.receiptId })
  })

  it("round 3: cannot detach source-created cash or its original replacement identity", async () => {
    const s = await setup()
    const a = await s.record()
    const original = await s.confirm(a)
    const b = await s.record({ source: "provider" })
    await s.match(b.evidenceId, original.receiptId, b.input.transactionReference)
    // Even a later match decision does not make a confirmation withdrawable.
    await unmatch(s, a.evidenceId, original.receiptId)
    await s.match(a.evidenceId, original.receiptId, a.input.transactionReference)
    await expect(s.act(s.decision({ action: "reject_match", evidenceId: a.evidenceId, receiptId: original.receiptId })))
      .rejects.toThrow("Source-created cash")
    await reverse(s, original.receiptId)
    await unmatch(s, a.evidenceId, original.receiptId)
    await unmatch(s, b.evidenceId, original.receiptId)
    const correctedA = await correct(s, a)
    const correctedB = await correct(s, b)
    const replacement = await s.confirm(correctedB)
    await unmatch(s, correctedB.evidenceId, replacement.receiptId)
    await expect(s.act(s.decision({ action: "reject_match", evidenceId: b.evidenceId, receiptId: original.receiptId })))
      .rejects.toThrow("Source-created cash")
    await expect(s.confirm(correctedA)).rejects.toThrow(replacement.receiptId)
    expect(await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId, reversedAt: null } })).toBe(1)
    expect(await prisma.settlementEvidenceDecision.count({ where: { source: { organizationId: s.org.organizationId }, action: "reject_match" } })).toBe(0)
  })

  it.each(["same_source", "connected_replacement"])(
    "round 3: refuses identity rejection after an applied %s return, including an older preview",
    async (route) => {
      const s = await setup()
      const a = await s.record()
      const original = await s.manual()
      await s.match(a.evidenceId, original.receiptId, a.input.transactionReference)
      let returning = a
      let returnedReceiptId = original.receiptId
      if (route === "connected_replacement") {
        const b = await s.record({ source: "provider" })
        await s.match(b.evidenceId, original.receiptId, b.input.transactionReference)
        await reverse(s, original.receiptId)
        await unmatch(s, a.evidenceId, original.receiptId)
        await unmatch(s, b.evidenceId, original.receiptId)
        const correctedB = await correct(s, b)
        const replacement = await s.manual("900")
        await s.match(correctedB.evidenceId, replacement.receiptId, b.input.transactionReference)
        // The third source reaches A's original receipt only through B's replacement history.
        returning = await s.record({ netAmount: "900" })
        await s.match(returning.evidenceId, replacement.receiptId, returning.input.transactionReference)
        returnedReceiptId = replacement.receiptId
      }
      const returned = await s.record({ ...returning.input, requestId: randomUUID(), eventReference: randomUUID(),
        state: "returned", reversesEvidenceId: returning.evidenceId })
      const reject = s.decision({ action: "reject_match", evidenceId: a.evidenceId, receiptId: original.receiptId })
      const preview = await s.caller.payments.previewEvidenceDecision(reject)
      await s.act(s.decision({ action: "return", evidenceId: returned.evidenceId, receiptId: returnedReceiptId }))
      const historyBefore = await s.caller.payments.evidenceHistory({ contactId: s.contact.id })
      await expect(s.caller.payments.decideEvidence({ decision: reject, previewToken: preview.previewToken }))
        .rejects.toThrow("financial return was already applied")
      await expect(s.act({ ...reject, requestId: randomUUID() })).rejects.toThrow("financial return was already applied")
      expect(await s.caller.payments.evidenceHistory({ contactId: s.contact.id })).toEqual(historyBefore)
      expect(await prisma.settlementEvidenceDecision.count({ where: { source: { organizationId: s.org.organizationId }, action: "return" } })).toBe(1)
      expect(await prisma.settlementReceipt.count({ where: { organizationId: s.org.organizationId, reversedAt: null } })).toBe(0)
    },
  )

})
