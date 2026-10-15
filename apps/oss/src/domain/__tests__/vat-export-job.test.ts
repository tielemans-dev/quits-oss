import { Effect } from "effect"
import { beforeEach, expect, it, vi } from "vitest"
const db = vi.hoisted(() => ({ job: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() }, jobStep: { updateMany: vi.fn() }, $transaction: vi.fn() }))
vi.mock("../../lib/db", () => ({ prisma: db }))
vi.mock("../../lib/exports/vat-overview", async original => ({ ...await original<object>(), vatOverview: vi.fn() }))
import { vatOverview, tastSelvSummary } from "../../lib/exports/vat-overview"
import { queueVatExport, handleVatExport } from "../vat-export-job"
import { Command, Db } from "../services"
import { StaleJobClaimError } from "../jobs"
const overview = { available: true as const, period: { from: "2026-07-01", to: "2026-09-30", date: "2026-12-01", label: "Q3", daysLeft: 47 }, outputVatMinor: "-101", inputVatMinor: null, payableVatMinor: null, inputVatUpdatedAt: null, inputVatUpdatedBy: null }
const job = { id: "job", organizationId: "org", claimToken: "claim", payload: overview, attempts: 1, createdAt: new Date() }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(vatOverview).mockResolvedValue(overview)
  db.job.create.mockResolvedValue({ id: "job" }); db.job.updateMany.mockResolvedValue({ count: 1 })
  db.$transaction.mockImplementation(fn => fn(db))
})
it("queues only a current authorized period, with a frozen snapshot and named steps", async () => {
  const run = (from: string) => Effect.runPromise(queueVatExport.handle({ from, clientRequestId: "click" }).pipe(
    Effect.provideService(Db, db as never), Effect.provideService(Command, { organizationId: "org", now: job.createdAt } as never)))
  expect(await run(overview.period.from)).toEqual({ jobId: "job" })
  expect(db.job.create.mock.calls[0]![0].data).toMatchObject({ organizationId: "org", payload: overview, steps: { create: [{ position: 0, label: "shell.request.vat.check" }, { position: 1, label: "shell.request.vat.prepare" }] } })
  await expect(run("2026-01-01")).rejects.toThrow("Reload")
  vi.mocked(vatOverview).mockResolvedValue({ available: false, reason: "registration" })
  await expect(run(overview.period.from)).rejects.toThrow("Reload")
  expect(db.job.create).toHaveBeenCalledTimes(1)
})
it("resumes after a lost runner with the same CSV and refuses stale claims", async () => {
  db.$transaction.mockImplementationOnce(fn => fn(db)).mockRejectedValueOnce(new Error("stopped"))
  await expect(handleVatExport(job)).rejects.toThrow("stopped")
  await handleVatExport({ ...job, claimToken: "replacement" })
  expect(db.job.updateMany).toHaveBeenLastCalledWith({ where: { id: "job", organizationId: "org", claimToken: "replacement" }, data: { result: tastSelvSummary(overview) } })
  db.job.updateMany.mockResolvedValue({ count: 0 }); db.jobStep.updateMany.mockClear()
  await expect(handleVatExport(job)).rejects.toBeInstanceOf(StaleJobClaimError)
  expect(db.jobStep.updateMany).not.toHaveBeenCalled()
})
it("maps exact negative sales VAT and leaves unknown TastSelv fields blank", () => {
  const file = tastSelvSummary(overview)
  expect(file.filename).toBe("moms-2026-07-01_2026-09-30.csv")
  expect(file.csv).toContain("Salgsmoms (udgående moms),-1.01,Fakturaer minus kreditnotaer")
  expect(file.csv).toContain("Købsmoms (indgående moms),,Ikke opgjort")
  expect(file.csv).toContain("Moms i alt,,Kan ikke opgøres uden købsmoms")
  expect(file.csv).toContain("Intet er indberettet")
  expect(tastSelvSummary({ ...overview, outputVatMinor: "12345678901234567890123" }).csv).toContain("123456789012345678901.23")
})
it("refuses to replay a click for a different period", async () => {
  db.job.findUnique.mockResolvedValue({ payload: overview })
  expect(await queueVatExport.validateReplay!({ from: "2026-07-01" }, { jobId: "job" })).toBeUndefined()
  expect(await queueVatExport.validateReplay!({ from: "2026-01-01" }, { jobId: "job" })).toMatchObject({ code: "idempotency_mismatch" })
})
it.each([["0", "-1.01"], ["1001", "-11.02"]])("keeps manual purchase VAT %s in the persisted worksheet job", async (inputVatMinor, payable) => {
  const payload = { ...overview, inputVatMinor }
  await handleVatExport({ ...job, payload })
  const csv = db.job.updateMany.mock.calls.at(-1)![0].data.result.csv
  expect(csv).toContain(`Moms i alt,${payable},Salgsmoms minus købsmoms`)
  expect(csv).toContain("Manuelt angivet for perioden")
})
