import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readProductEnv } from "@quits/shared/runtimeEnv"
import { executeIssuanceCommand } from "../../application/issuance"
import { createContact } from "../../domain/commands/contacts"
import { issueCreditNote } from "../../domain/commands/credit-notes"
import { createInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { recordPayment, voidPayment } from "../../domain/commands/payments"
import { createRecurringInvoice } from "../../domain/commands/recurring"
import { resolveUserActor } from "../../domain/user-actor"
import { prisma } from "../../lib/db"
import { bootstrapQuitsRuntime } from "../../lib/runtime/bootstrap"
import { encryptSecret } from "../../lib/secrets"
import { selfhostRuntimeServices } from "../runtime"

/**
 * A synthetic installation for rehearsing backup and restore without anyone's real data: one
 * seller, one customer, invoices in three currencies with issued PDFs, payments (one voided), a
 * credit note, an encrypted provider secret, and work that is due or queued. Every name, amount
 * and secret is made up. Nothing here sends anything: the one queued email is queued while
 * operations are held, and it is the point of the exercise that a restore leaves it queued.
 */
export type RehearsalFixture = { organizationId: string; invoiceIds: string[]; pendingEmailInvoiceId: string }

async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>) {
  const saved = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]))
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await run()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function completed<T extends { status: string }>(result: T): Extract<T, { status: "completed" }> {
  if (result.status !== "completed") throw new Error(`Fixture command failed: ${JSON.stringify(result)}`)
  return result as Extract<T, { status: "completed" }>
}

/** Fills an empty, migrated database through the application's own commands. Needs BETTER_AUTH_SECRET. */
export async function seedRehearsalFixture(): Promise<RehearsalFixture> {
  bootstrapQuitsRuntime({})
  if ((await prisma.organization.count()) > 0) {
    throw new Error("The database already has an organization. Fixtures are only created in an empty database.")
  }
  const organizationId = randomUUID()
  const userId = `fixture-${organizationId.slice(0, 8)}`
  await prisma.organization.create({ data: { id: organizationId, name: "Rehearsal Studio ApS", slug: `rehearsal-${organizationId.slice(0, 8)}`, createdAt: new Date() } })
  await prisma.user.create({ data: { id: userId, email: `${userId}@rehearsal.invalid`, name: "Rehearsal Owner", emailVerified: true, createdAt: new Date(), updatedAt: new Date() } })
  await prisma.member.create({ data: { id: `${organizationId}:${userId}`, organizationId, userId, role: "admin", createdAt: new Date() } })
  await prisma.orgSettings.create({
    data: {
      organizationId,
      countryCode: "US",
      locale: "en-US",
      timezone: "UTC",
      defaultCurrency: "USD",
      baseCurrency: "USD",
      currency: "USD",
      taxRegime: "us_sales_tax",
      companyName: "Rehearsal Studio ApS",
      companyEmail: "billing@rehearsal.invalid",
      onboardingStatus: "completed",
      onboardingCompletedAt: new Date(),
      stripePublishableKey: "pk_test_rehearsal",
      stripeSecretKeyEnc: encryptSecret("sk_test_rehearsal_not_a_real_key"),
      stripeWebhookSecretEnc: encryptSecret("whsec_rehearsal_not_a_real_secret"),
    },
  })
  await prisma.installationState.upsert({ where: { id: "default" }, create: { id: "default", isSetupComplete: true, distribution: "selfhost" }, update: { isSetupComplete: true } })

  const actor = await resolveUserActor({ organizationId, userId, userName: "Rehearsal Owner" })
  if (!actor) throw new Error("Fixture membership was not created")
  const contact = completed(await executeIssuanceCommand(createContact, { name: "Acme Rehearsal", email: "accounts@acme.invalid" }, { actor }))

  const issue = async (currency: string, unitPrice: number, queueEmail: boolean) => {
    const draft = completed(
      await executeIssuanceCommand(createInvoiceDraft, { contactId: contact.result.id, dueDate: "2099-12-01", currency, taxRate: 25, items: [{ description: "Design work", quantity: 2, unitPrice }] }, { actor })
    )
    const valuation = currency === "USD" ? {} : { exchangeRate: "0.8", rateDate: "2026-10-07" }
    // With mail delivery not configured an invoice is issued at once. With it configured and
    // operations held, the invoice waits for its email, which stays queued as pending work.
    const env = queueEmail
      ? { QUITS_OPERATIONS_HOLD: "true", EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_REQUIRE_TLS: "false", FROM_EMAIL: "billing@rehearsal.invalid" }
      : { QUITS_OPERATIONS_HOLD: undefined, EMAIL_PROVIDER: "resend", RESEND_API_KEY: undefined }
    completed(await withEnv(env, () => executeIssuanceCommand(sendInvoice, { id: draft.result.id, allowSendWithoutEmail: true, ...valuation }, { actor })))
    return draft.result.id as string
  }
  const usd = await issue("USD", 100, false)
  const eur = await issue("EUR", 80.5, false)
  const dkk = await issue("DKK", 1000, false)
  const pendingEmailInvoiceId = await issue("USD", 10, true)

  const pay = async (invoiceId: string, amount: number) =>
    completed(await executeIssuanceCommand(recordPayment, { invoiceId, amount, paidAt: "2026-01-15", method: "bank_transfer" }, { actor }))
  await pay(usd, 100)
  const bounced = await pay(eur, 50)
  completed(await executeIssuanceCommand(voidPayment, { paymentId: bounced.result.payment.id, reason: "Bounced" }, { actor }))
  await pay(eur, 20.25)
  completed(await executeIssuanceCommand(issueCreditNote, { reason: "Goodwill", invoiceId: dkk, mode: "amount", amount: 250 }, { actor }))

  // Work that came due while the installation was down.
  await prisma.invoiceReminder.create({ data: { invoiceId: usd, offsetDays: 7, scheduledFor: new Date("2026-02-01T00:00:00Z") } })
  const schedule = completed(
    await executeIssuanceCommand(
      createRecurringInvoice,
      { name: "Retainer", contactId: contact.result.id, items: [{ description: "Retainer", quantity: 1, unitPrice: 1000 }], taxRate: 25, intervalCount: 1, intervalUnit: "month", startDate: "2026-01-01", dueInDays: 14 },
      { actor }
    )
  )
  await prisma.recurringInvoice.update({ where: { id: schedule.result.id }, data: { nextRunAt: new Date("2026-02-01") } })
  return { organizationId, invoiceIds: [usd, eur, dkk], pendingEmailInvoiceId }
}

/**
 * `bun src/selfhost/recovery/fixture.ts --disposable` fills the configured empty database and
 * artifact directory with the synthetic installation. Refuses a non-empty database.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--disposable")) {
    console.error("This writes a synthetic installation into DATABASE_URL and the artifact directory.\nPass --disposable to confirm that database is throw-away.")
    process.exit(2)
  }
  bootstrapQuitsRuntime({ services: selfhostRuntimeServices(process.env) })
  const fixture = await seedRehearsalFixture()
  console.log(`Created a synthetic installation (organization ${fixture.organizationId}) with ${fixture.invoiceIds.length + 1} invoices.`)
  console.log(`Artifacts are in ${readProductEnv(process.env, "ARTIFACT_DIR") ?? "./data/artifacts"}.`)
  await prisma.$disconnect()
}
