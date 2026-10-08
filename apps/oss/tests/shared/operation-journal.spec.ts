import { test, expect } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { appendEvents } from "../../src/domain/events"
import { resetDatabase, seedPublicInvoice, loginAsAdmin } from "../e2e/support"

// Synthetic persisted interruption evidence. This checks the real page and authorized API,
// without contacting a provider or claiming a real customer delivery.
test("uncertain SMTP journal preserves one record and requires an explicit manual decision", async ({
  page,
  baseURL
}, testInfo) => {
  const database = new URL(process.env.DATABASE_URL!)
  if (
    !baseURL ||
    database.hostname !== "127.0.0.1" ||
    database.pathname !== "/quits_e2e"
  )
    throw new Error(
      "Journal browser check requires the disposable shared harness"
    )
  console.info(
    "Journal shared database",
    database.hostname,
    database.port,
    database.pathname
  )
  await resetDatabase()
  const invoice = await seedPublicInvoice()
  const row = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
    include: { contact: true }
  })
  const member = await prisma.member.findFirstOrThrow({
    where: { organizationId: row.organizationId, role: "admin" }
  })
  const actor = {
    kind: "user" as const,
    organizationId: row.organizationId,
    userId: member.userId,
    roles: ["admin" as const],
    label: "Synthetic browser operator"
  }
  const attemptedAt = new Date("2026-10-08T12:00:00Z")
  const commandId = "journal-browser-creation"
  const sendCommandId = "journal-browser-send"
  const recipient = row.contact.email ?? "recipient@example.test"
  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: row.id },
      data: {
        lastEmailAttemptAt: attemptedAt,
        lastEmailAttemptOutcome: "unconfirmed"
      }
    })
    await tx.commandReceipt.create({
      data: {
        id: commandId,
        organizationId: row.organizationId,
        actorKey: `user:${member.userId}`,
        clientRequestId: commandId,
        commandType: "invoice.create_draft",
        status: "completed"
      }
    })
    await tx.commandReceipt.create({
      data: {
        id: sendCommandId,
        organizationId: row.organizationId,
        actorKey: `user:${member.userId}`,
        clientRequestId: sendCommandId,
        commandType: "invoice.send",
        status: "completed",
        target: { documentType: "invoice", documentId: row.id }
      }
    })
    await appendEvents(tx, {
      organizationId: row.organizationId,
      actor,
      commandId,
      approvedByUserId: null,
      occurredAt: attemptedAt,
      events: [
        {
          aggregateType: "invoice",
          aggregateId: row.id,
          type: "invoice.draft_created",
          payload: {
            number: null,
            contactId: row.contactId,
            totalGross: row.totalGross.toNumber()
          }
        }
      ]
    })
    await tx.job.create({
      data: {
        organizationId: row.organizationId,
        type: "email.deliver",
        status: "failed",
        attempts: 1,
        dedupeKey: "email:journal-browser-send",
        result: {
          outcome: "unconfirmed",
          message: "Synthetic lost SMTP answer"
        },
        payload: {
          message: {
            from: "sender@example.test",
            to: recipient,
            subject: "Synthetic fixture",
            html: "<p>Synthetic journal fixture</p>"
          },
          idempotencyKey: "journal-browser-send",
          actor,
          commandId: sendCommandId,
          approvedByUserId: null,
          requests: 1,
          provider: "smtp",
          completion: {
            kind: "invoice.send",
            target: {
              documentId: row.id,
              attemptAt: attemptedAt.toISOString(),
              recipient,
              number: row.number,
              publicLinkKeyVersion: String(row.publicPaymentKeyVersion)
            }
          },
          attempts: [
            { startedAt: attemptedAt.toISOString(), outcome: "uncertain" }
          ]
        }
      }
    })
  })
  await loginAsAdmin(page)
  await page.goto(`/invoices/${row.id}`)
  const history = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Operation history", { exact: true }) })
  await expect(
    history.getByText("Document creation completed", { exact: true })
  ).toBeVisible()
  await expect(
    history.getByRole("link", { name: `Record: ${row.number}` })
  ).toHaveAttribute("href", `/invoices/${row.id}`)
  await expect(
    history.getByText(`Email to ${recipient}`, { exact: true })
  ).toBeVisible()
  await expect(
    history.getByText("External outcome uncertain", { exact: true })
  ).toBeVisible()
  await expect(
    history.getByRole("button", { name: "Recover this delivery step" })
  ).toHaveCount(0)
  await expect(
    history.getByRole("button", { name: "Check provider status" })
  ).toHaveCount(0)
  await history.getByRole("button", { name: "Review manual resend" }).click()
  const submit = history.getByRole("button", {
    name: "Record decision and resend"
  })
  await expect(submit).toBeDisabled()
  await history
    .getByLabel("Verification and reason for resending")
    .fill("Recipient checked their inbox and requested another copy")
  await expect(submit).toBeDisabled()
  await history.getByRole("checkbox").check()
  await expect(submit).toBeEnabled()
  await history.getByRole("button", { name: "Cancel resend decision" }).click()
  await expect(history.getByRole("checkbox")).toHaveCount(0)
  await expect(
    history.getByText("External outcome uncertain", { exact: true })
  ).toBeVisible()
  expect(await prisma.invoice.count()).toBe(1)
  expect(await prisma.job.count({ where: { type: "email.deliver" } })).toBe(1)
  expect(
    await prisma.domainEvent.count({
      where: { type: "delivery.manual_resend_requested" }
    })
  ).toBe(0)
  // The stored email becomes unusable after revocation, but an audited current-link
  // replacement is offered. A second revocation while reviewing must invalidate it.
  await prisma.invoice.update({
    where: { id: row.id },
    data: { publicPaymentKeyVersion: { increment: 1 } }
  })
  await history.getByRole("button", { name: "Refresh history" }).click()
  await expect(
    history.getByRole("button", { name: "Review manual resend" })
  ).toHaveCount(0)
  await history
    .getByRole("button", { name: "Review replacement with current link" })
    .click()
  await expect(
    history.getByText(`Reviewed recipient: ${recipient}`, { exact: true })
  ).toBeVisible()
  await expect(
    history.getByText(/earlier email contains a revoked link/)
  ).toBeVisible()
  const replacementSubmit = history.getByRole("button", {
    name: "Record decision and resend"
  })
  await expect(replacementSubmit).toBeDisabled()
  await history
    .getByLabel("Verification and reason for resending")
    .fill("Recipient verified the revoked link and requested the current copy")
  await expect(replacementSubmit).toBeDisabled()
  await history.getByRole("checkbox").check()
  await expect(replacementSubmit).toBeEnabled()
  await testInfo.attach("journal-replacement-desktop", {
    body: await history.screenshot(),
    contentType: "image/png"
  })
  await prisma.invoice.update({
    where: { id: row.id },
    data: { publicPaymentKeyVersion: { increment: 1 } }
  })
  await replacementSubmit.click()
  await expect(history.getByRole("alert")).toHaveText(
    "The reviewed document, recipient or public link changed. Refresh the operation history and verify the new target."
  )
  await expect(
    history.getByText("External outcome uncertain", { exact: true })
  ).toBeVisible()
  expect(await prisma.invoice.count()).toBe(1)
  expect(await prisma.job.count({ where: { type: "email.deliver" } })).toBe(1)
  expect(
    await prisma.domainEvent.count({
      where: { type: "delivery.manual_resend_requested" }
    })
  ).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await testInfo.attach("journal-replacement-mobile", {
    body: await history.screenshot(),
    contentType: "image/png"
  })
})
