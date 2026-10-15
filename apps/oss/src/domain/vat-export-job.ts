import { Effect } from "effect"
import { z } from "zod"
import { prisma } from "../lib/db"
import { tastSelvSummary, vatOverview } from "../lib/exports/vat-overview"
import { defineCommand } from "./command"
import { InvalidState } from "./errors"
import { registerJobHandler, StaleJobClaimError, type JobHandler } from "./jobs"
import { Command, Db } from "./services"

export const VAT_EXPORT_JOB = "vat.summary"
export const queueVatExport = defineCommand({
  type: "vat.queue_export", permission: "export:read", outwardFacing: false, namespaceRequestId: true,
  input: z.object({ clientRequestId: z.string().min(1).max(200), from: z.iso.date() }),
  validateReplay: async (input, result: { jobId: string }) => {
    const job = await prisma.job.findUnique({ where: { id: result.jobId }, select: { payload: true } })
    return (job?.payload as { period?: { from: string } })?.period?.from === (input as { from?: string } | null)?.from
      ? undefined : new InvalidState({ code: "idempotency_mismatch", message: "This request ID belongs to another VAT period" })
  },
  summarize: () => "Prepare a VAT summary for manual TastSelv entry",
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const { organizationId, now } = yield* Command
    const overview = yield* Effect.promise(() => vatOverview(db, organizationId, now))
    if (!overview.available || overview.period.from !== input.from) return yield* new InvalidState({ code: "vat_unavailable", message: "Reload the VAT overview before exporting" })
    const job = yield* Effect.promise(() => db.job.create({ data: {
      organizationId, type: VAT_EXPORT_JOB, title: "shell.request.title.vat", payload: overview,
      steps: { create: ["shell.request.vat.check", "shell.request.vat.prepare"].map((label, position) => ({ position, label })) },
    } }))
    return { jobId: job.id }
  }),
})

/** Each checkpoint commits under the runner's claim, so a replacement runner can resume safely. */
export const handleVatExport: JobHandler = async job => {
  const overview = z.object({ available: z.literal(true), outputVatMinor: z.string().regex(/^-?\d+$/),
    inputVatMinor: z.string().regex(/^\d+$/).nullable().optional(),
    period: z.object({ from: z.iso.date(), to: z.iso.date(), date: z.iso.date(), label: z.string(), daysLeft: z.number() }),
  }).parse(job.payload)
  const owned = { id: job.id, organizationId: job.organizationId, claimToken: job.claimToken }
  for (const position of [0, 1]) {
    await prisma.$transaction(async db => {
      const changed = await db.job.updateMany({ where: owned, data: position === 1 ? { result: tastSelvSummary(overview) } : { updatedAt: new Date() } })
      if (!changed.count) throw new StaleJobClaimError()
      await db.jobStep.updateMany({ where: { jobId: job.id, position }, data: { status: "succeeded", error: null } })
    })
  }
}
registerJobHandler(VAT_EXPORT_JOB, handleVatExport)
