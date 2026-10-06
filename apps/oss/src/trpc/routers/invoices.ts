import { TRPCError } from "@trpc/server"
import { z } from "zod"
import {
  computeDocumentTotals,
  resolveCountryProfile,
  validateDocument,
} from "../../lib/compliance"
import { prisma } from "../../lib/db"
import {
  createEmailDeliveryAttempt,
  getEmailDeliveryRuntimeStatus,
} from "../../lib/email-delivery"
import {
  readDocumentSendingDomainState,
  resolveDocumentEmailEnvelope,
} from "../../lib/document-email-sending"
import { sendInvoiceEmail } from "../../lib/email"
import { billingProvider } from "../../lib/billing"
import { assertCloudOnboardingComplete } from "../../lib/onboarding/guard"
import { appLogger } from "../../lib/observability"
import {
  getPublicInvoicePaymentUrl,
} from "../../lib/payments/public"
import { getStripePaymentConfigurationState } from "../../lib/payments/stripe"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { router, authorizedProcedure } from "../init"

const invoiceLogger = appLogger.child("invoices")

const isoDateSchema = z.string().refine(
  (value) => !Number.isNaN(new Date(value).getTime()),
  "Invalid date"
)

const currencyCodeSchema = z.string().trim().regex(/^[A-Z]{3}$/)

const invoiceLineItemInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(1_000_000),
  unitPrice: z.number().min(0).max(1_000_000_000),
})

const emailAddressSchema = z.string().trim().email()

function mapInvoiceItemForUi(item: {
  quantity: { toNumber: () => number }
  unitPriceGross: { toNumber: () => number }
  lineGross: { toNumber: () => number }
}) {
  return {
    quantity: item.quantity.toNumber(),
    unitPrice: item.unitPriceGross.toNumber(),
    total: item.lineGross.toNumber(),
  }
}

export const invoicesRouter = router({
  list: authorizedProcedure("invoice:read")
    .input(
      z
        .object({
          status: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {
        organizationId: ctx.organizationId,
      }
      if (input?.status) where.status = input.status

      const invoices = await prisma.invoice.findMany({
        where,
        include: { contact: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      })

      return invoices.map((inv) => ({
        ...inv,
        subtotal: inv.subtotalNet.toNumber(),
        taxAmount: inv.totalTax.toNumber(),
        total: inv.totalGross.toNumber(),
        publicPaymentUrl: getPublicInvoicePaymentUrl(inv),
      }))
    }),

  get: authorizedProcedure("invoice:read")
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
        },
      })

      return {
        ...invoice,
        subtotal: invoice.subtotalNet.toNumber(),
        taxAmount: invoice.totalTax.toNumber(),
        total: invoice.totalGross.toNumber(),
        publicPaymentUrl: getPublicInvoicePaymentUrl(invoice),
        items: invoice.items.map((item) => ({
          ...item,
          ...mapInvoiceItemForUi(item),
        })),
      }
    }),

  create: authorizedProcedure("invoice:create")
    .input(
      z.object({
        contactId: z.string().trim().min(1),
        dueDate: isoDateSchema,
        currency: currencyCodeSchema.optional(),
        notes: z.string().trim().max(5000).optional(),
        taxRate: z.number().min(0).max(100).default(0),
        items: z.array(invoiceLineItemInputSchema).min(1).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertCloudOnboardingComplete(ctx.organizationId)

      const contact = await prisma.contact.findFirst({
        where: { id: input.contactId, organizationId: ctx.organizationId },
        select: {
          id: true,
          name: true,
          email: true,
          company: true,
          address: true,
          city: true,
          state: true,
          zip: true,
          country: true,
        },
      })
      if (!contact) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid contact for this organization",
        })
      }

      await billingProvider.assertInvoiceCreationAllowed(ctx.organizationId)

      const result = await prisma.$transaction(async (tx) => {
        let settings = await tx.orgSettings.findUnique({
          where: { organizationId: ctx.organizationId },
        })
        if (!settings) {
          settings = await tx.orgSettings.create({
            data: { organizationId: ctx.organizationId },
          })
        }

        const sellerTaxIds = await tx.organizationTaxId.findMany({
          where: { organizationId: ctx.organizationId },
          select: { scheme: true, value: true, countryCode: true },
        })

        const num = settings.invoiceNextNum
        const invoiceNumber = `${settings.invoicePrefix}-${String(num).padStart(4, "0")}`
        const profile = resolveCountryProfile(settings.countryCode)
        const activeCurrency =
          input.currency ?? settings.defaultCurrency ?? settings.currency

        const totals = computeDocumentTotals(profile, {
          items: input.items,
          taxRate: input.taxRate,
          pricesIncludeTax: settings.pricesIncludeTax,
        })

        const complianceIssues = validateDocument(profile, {
          sellerTaxIds,
          buyerTaxIds: [],
          taxRate: input.taxRate,
        })
        const complianceStatus = complianceIssues.some((issue) => issue.severity === "error")
          ? "invalid"
          : complianceIssues.length > 0
            ? "warning"
            : "valid"

        const invoice = await tx.invoice.create({
          data: {
            organizationId: ctx.organizationId,
            contactId: input.contactId,
            number: invoiceNumber,
            status: "draft",
            dueDate: new Date(input.dueDate),
            subtotalNet: totals.subtotalNet,
            totalTax: totals.totalTax,
            totalGross: totals.totalGross,
            currency: activeCurrency,
            countryCode: settings.countryCode,
            locale: settings.locale,
            timezone: settings.timezone,
            taxRegime: settings.taxRegime,
            pricesIncludeTax: settings.pricesIncludeTax,
            sellerSnapshot: {
              companyName: settings.companyName ?? null,
              companyEmail: settings.companyEmail ?? null,
              companyAddress: settings.companyAddress ?? null,
              taxIds: sellerTaxIds,
            },
            buyerSnapshot: {
              name: contact.name,
              email: contact.email ?? null,
              company: contact.company ?? null,
              address: contact.address ?? null,
              city: contact.city ?? null,
              state: contact.state ?? null,
              zip: contact.zip ?? null,
              country: contact.country ?? null,
            },
            complianceStatus,
            complianceErrors: complianceIssues,
            notes: input.notes,
            items: {
              create: totals.lines.map((line, index) => ({
                description: line.description,
                quantity: line.quantity,
                unitPriceNet: line.unitPriceNet,
                unitPriceGross: line.unitPriceGross,
                lineNet: line.lineNet,
                lineTax: line.lineTax,
                lineGross: line.lineGross,
                taxRate: line.taxRate,
                taxCategory: "standard",
                sortOrder: index,
              })),
            },
          },
          include: { items: true },
        })

        await tx.orgSettings.update({
          where: { organizationId: ctx.organizationId },
          data: { invoiceNextNum: num + 1 },
        })

        return invoice
      })

      return {
        ...result,
        subtotal: result.subtotalNet.toNumber(),
        taxAmount: result.totalTax.toNumber(),
        total: result.totalGross.toNumber(),
        items: result.items.map((item) => ({
          ...item,
          ...mapInvoiceItemForUi(item),
        })),
      }
    }),

  update: authorizedProcedure("invoice:update")
    .input(
      z.object({
        id: z.string(),
        contactId: z.string().trim().min(1).optional(),
        dueDate: isoDateSchema.optional(),
        currency: currencyCodeSchema.optional(),
        notes: z.string().trim().max(5000).optional(),
        taxRate: z.number().min(0).max(100).optional(),
        items: z.array(invoiceLineItemInputSchema).min(1).max(100).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.invoice.findFirstOrThrow({
          where: { id: input.id, organizationId: ctx.organizationId },
        })

        if (existing.status !== "draft") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Only draft invoices can be edited",
          })
        }

        const settings = await tx.orgSettings.findUnique({
          where: { organizationId: ctx.organizationId },
        })
        const profile = resolveCountryProfile(settings?.countryCode ?? existing.countryCode)

        const updateData: Record<string, unknown> = {}
        if (input.contactId) {
          const contact = await tx.contact.findFirst({
            where: { id: input.contactId, organizationId: ctx.organizationId },
            select: {
              name: true,
              email: true,
              company: true,
              address: true,
              city: true,
              state: true,
              zip: true,
              country: true,
            },
          })
          if (!contact) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Invalid contact for this organization",
            })
          }
          updateData.contactId = input.contactId
          updateData.buyerSnapshot = {
            name: contact.name,
            email: contact.email ?? null,
            company: contact.company ?? null,
            address: contact.address ?? null,
            city: contact.city ?? null,
            state: contact.state ?? null,
            zip: contact.zip ?? null,
            country: contact.country ?? null,
          }
        }
        if (input.dueDate) updateData.dueDate = new Date(input.dueDate)
        if (input.currency) updateData.currency = input.currency
        if (input.notes !== undefined) updateData.notes = input.notes

        if (input.items) {
          await tx.invoiceItem.deleteMany({ where: { invoiceId: input.id } })

          const taxRate = input.taxRate ?? (existing.subtotalNet.toNumber() > 0
            ? (existing.totalTax.toNumber() / existing.subtotalNet.toNumber()) * 100
            : 0)

          const totals = computeDocumentTotals(profile, {
            items: input.items,
            taxRate,
            pricesIncludeTax: settings?.pricesIncludeTax ?? existing.pricesIncludeTax,
          })

          updateData.subtotalNet = totals.subtotalNet
          updateData.totalTax = totals.totalTax
          updateData.totalGross = totals.totalGross

          await tx.invoiceItem.createMany({
            data: totals.lines.map((line, index) => ({
              invoiceId: input.id,
              description: line.description,
              quantity: line.quantity,
              unitPriceNet: line.unitPriceNet,
              unitPriceGross: line.unitPriceGross,
              lineNet: line.lineNet,
              lineTax: line.lineTax,
              lineGross: line.lineGross,
              taxRate: line.taxRate,
              taxCategory: "standard",
              sortOrder: index,
            })),
          })
        } else if (input.taxRate !== undefined) {
          const items = await tx.invoiceItem.findMany({
            where: { invoiceId: input.id },
            orderBy: { sortOrder: "asc" },
          })

          const pricesIncludeTax = settings?.pricesIncludeTax ?? existing.pricesIncludeTax
          const totals = computeDocumentTotals(profile, {
            items: items.map((item) => ({
              description: item.description,
              quantity: item.quantity.toNumber(),
              unitPrice: pricesIncludeTax
                ? item.unitPriceGross.toNumber()
                : item.unitPriceNet.toNumber(),
            })),
            taxRate: input.taxRate,
            pricesIncludeTax,
          })

          updateData.subtotalNet = totals.subtotalNet
          updateData.totalTax = totals.totalTax
          updateData.totalGross = totals.totalGross

          await Promise.all(
            totals.lines.map((line, index) => {
              const existingItem = items[index]
              if (!existingItem) return Promise.resolve()
              return tx.invoiceItem.update({
                where: { id: existingItem.id },
                data: {
                  unitPriceNet: line.unitPriceNet,
                  unitPriceGross: line.unitPriceGross,
                  lineNet: line.lineNet,
                  lineTax: line.lineTax,
                  lineGross: line.lineGross,
                  taxRate: line.taxRate,
                },
              })
            })
          )
        }

        return tx.invoice.update({
          where: { id: input.id },
          data: updateData,
          include: {
            contact: true,
            items: { orderBy: { sortOrder: "asc" } },
          },
        })
      })

      return {
        ...result,
        subtotal: result.subtotalNet.toNumber(),
        taxAmount: result.totalTax.toNumber(),
        total: result.totalGross.toNumber(),
        items: result.items.map((item) => ({
          ...item,
          ...mapInvoiceItemForUi(item),
        })),
      }
    }),

  delete: authorizedProcedure("invoice:delete")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
      })

      if (invoice.status !== "draft") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only draft invoices can be deleted",
        })
      }

      return prisma.invoice.delete({
        where: { id: input.id },
      })
    }),

  send: authorizedProcedure("invoice:send")
    .input(
      z.object({
        id: z.string(),
        allowSendWithoutEmail: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
        },
      })

      if (invoice.status !== "draft") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only draft invoices can be sent",
        })
      }

      const orgSettings = await prisma.orgSettings.findUnique({
        where: { organizationId: ctx.organizationId },
      })
      const envelope = resolveDocumentEmailEnvelope({
        orgName: orgSettings?.companyName,
        orgBillingEmail: orgSettings?.companyEmail,
        sharedFromEmail: process.env.FROM_EMAIL ?? "noreply@yaip.app",
        branded: readDocumentSendingDomainState(orgSettings ?? {}),
      })
      const profile = resolveCountryProfile(orgSettings?.countryCode ?? invoice.countryCode)
      const sellerTaxIds = await prisma.organizationTaxId.findMany({
        where: { organizationId: ctx.organizationId },
        select: { scheme: true, value: true, countryCode: true },
      })

      const taxRate = invoice.subtotalNet.toNumber() > 0
        ? (invoice.totalTax.toNumber() / invoice.subtotalNet.toNumber()) * 100
        : 0
      const complianceIssues = validateDocument(profile, {
        sellerTaxIds,
        buyerTaxIds: [],
        taxRate,
      })
      const blockingIssues = complianceIssues.filter((issue) => issue.severity === "error")
      if (blockingIssues.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Compliance check failed: ${blockingIssues.map((i) => i.code).join(", ")}`,
        })
      }

      const sentAt = new Date()
      const stripeConfigured = getStripePaymentConfigurationState({
        stripePublishableKey: orgSettings?.stripePublishableKey ?? null,
        stripeSecretKeyEnc: orgSettings?.stripeSecretKeyEnc ?? null,
        stripeWebhookSecretEnc: orgSettings?.stripeWebhookSecretEnc ?? null,
      }).configured
      const publicPaymentIssuedAt = stripeConfigured
        ? invoice.publicPaymentIssuedAt ?? sentAt
        : null
      const publicPaymentUrl = stripeConfigured
        ? getPublicInvoicePaymentUrl({
            id: invoice.id,
            status: "sent",
            paymentStatus: invoice.paymentStatus,
            publicPaymentIssuedAt,
            publicPaymentKeyVersion: invoice.publicPaymentKeyVersion,
          })
        : null
      const emailDelivery = getEmailDeliveryRuntimeStatus({
        managed: getRuntimeCapabilities().emailDelivery.managed,
        resendApiKey: process.env.RESEND_API_KEY,
        fromEmail: process.env.FROM_EMAIL,
      })
      const contactEmail = invoice.contact.email?.trim() ?? ""
      let emailSent = false
      let emailSkipReason: string | undefined

      if (!emailAddressSchema.safeParse(contactEmail).success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Contact has no email address",
        })
      }

      if (!emailDelivery.available) {
        if (!input.allowSendWithoutEmail) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Email delivery is not configured",
          })
        }

        emailSkipReason = "Email delivery is not configured"
        invoiceLogger.warn("invoice.email.skipped", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          reason: "provider_missing",
        })
        const updated = await prisma.invoice.update({
          where: { id: input.id },
          data: {
            status: "sent",
            issueDate: sentAt,
            publicPaymentIssuedAt,
            ...createEmailDeliveryAttempt({
              at: sentAt,
              outcome: "skipped",
              code: "provider_missing",
              message: emailSkipReason,
            }),
          },
        })

        return { ...updated, emailSent, emailSkipReason }
      }

      try {
        await sendInvoiceEmail({
          to: contactEmail,
          fromName: envelope.fromName,
          fromEmail: envelope.fromEmail,
          replyTo: envelope.replyTo,
          invoice: {
            ...invoice,
            issueDate: sentAt,
            subtotal: invoice.subtotalNet.toNumber(),
            taxAmount: invoice.totalTax.toNumber(),
            total: invoice.totalGross.toNumber(),
            items: invoice.items.map((i) => ({
              description: i.description,
              quantity: i.quantity.toNumber(),
              unitPrice: i.unitPriceGross.toNumber(),
              total: i.lineGross.toNumber(),
            })),
          },
          org: {
            companyName: orgSettings?.companyName,
            companyEmail: orgSettings?.companyEmail,
            locale: orgSettings?.locale,
            timezone: orgSettings?.timezone,
          },
          contactName: invoice.contact.name,
          publicPaymentUrl,
        })
        emailSent = true
        invoiceLogger.info("invoice.email.sent", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          usingBrandedDomain: envelope.usingBrandedDomain,
          hasPublicPaymentUrl: Boolean(publicPaymentUrl),
        })
      } catch (error) {
        invoiceLogger.error("invoice.email.failed", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          error,
        })
        await prisma.invoice.update({
          where: { id: input.id },
          data: {
            ...createEmailDeliveryAttempt({
              outcome: "failed",
              code: "send_failed",
              message: "Failed to send invoice email.",
            }),
          },
        })
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Failed to send invoice email. Invoice was not marked as sent.",
        })
      }

      const updated = await prisma.invoice.update({
        where: { id: input.id },
        data: {
          status: "sent",
          issueDate: sentAt,
          publicPaymentIssuedAt,
          ...createEmailDeliveryAttempt({
            at: sentAt,
            outcome: "sent",
            code: "sent",
            message: "Invoice email sent.",
          }),
        },
      })

      return { ...updated, emailSent, emailSkipReason }
    }),

  resendEmail: authorizedProcedure("invoice:send")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
        },
      })

      if (!["sent", "overdue"].includes(invoice.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only sent or overdue invoices can be resent by email",
        })
      }

      const orgSettings = await prisma.orgSettings.findUnique({
        where: { organizationId: ctx.organizationId },
      })
      const envelope = resolveDocumentEmailEnvelope({
        orgName: orgSettings?.companyName,
        orgBillingEmail: orgSettings?.companyEmail,
        sharedFromEmail: process.env.FROM_EMAIL ?? "noreply@yaip.app",
        branded: readDocumentSendingDomainState(orgSettings ?? {}),
      })
      const stripeConfigured = getStripePaymentConfigurationState({
        stripePublishableKey: orgSettings?.stripePublishableKey ?? null,
        stripeSecretKeyEnc: orgSettings?.stripeSecretKeyEnc ?? null,
        stripeWebhookSecretEnc: orgSettings?.stripeWebhookSecretEnc ?? null,
      }).configured
      const publicPaymentUrl =
        stripeConfigured && invoice.publicPaymentIssuedAt
          ? getPublicInvoicePaymentUrl(invoice)
          : null
      const emailDelivery = getEmailDeliveryRuntimeStatus({
        managed: getRuntimeCapabilities().emailDelivery.managed,
        resendApiKey: process.env.RESEND_API_KEY,
        fromEmail: process.env.FROM_EMAIL,
      })
      const contactEmail = invoice.contact.email?.trim() ?? ""

      if (!emailAddressSchema.safeParse(contactEmail).success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Contact has no email address",
        })
      }

      if (!emailDelivery.available) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Email delivery is not configured",
        })
      }

      try {
        await sendInvoiceEmail({
          to: contactEmail,
          fromName: envelope.fromName,
          fromEmail: envelope.fromEmail,
          replyTo: envelope.replyTo,
          invoice: {
            ...invoice,
            subtotal: invoice.subtotalNet.toNumber(),
            taxAmount: invoice.totalTax.toNumber(),
            total: invoice.totalGross.toNumber(),
            items: invoice.items.map((i) => ({
              description: i.description,
              quantity: i.quantity.toNumber(),
              unitPrice: i.unitPriceGross.toNumber(),
              total: i.lineGross.toNumber(),
            })),
          },
          org: {
            companyName: orgSettings?.companyName,
            companyEmail: orgSettings?.companyEmail,
            locale: orgSettings?.locale,
            timezone: orgSettings?.timezone,
          },
          contactName: invoice.contact.name,
          publicPaymentUrl,
        })
        invoiceLogger.info("invoice.email.resent", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          usingBrandedDomain: envelope.usingBrandedDomain,
          hasPublicPaymentUrl: Boolean(publicPaymentUrl),
        })
      } catch (error) {
        invoiceLogger.error("invoice.email.resend_failed", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          error,
        })
        await prisma.invoice.update({
          where: { id: input.id },
          data: {
            ...createEmailDeliveryAttempt({
              outcome: "failed",
              code: "send_failed",
              message: "Failed to send invoice email.",
            }),
          },
        })
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to resend invoice email.",
        })
      }

      const updated = await prisma.invoice.update({
        where: { id: input.id },
        data: {
          ...createEmailDeliveryAttempt({
            outcome: "sent",
            code: "sent",
            message: "Invoice email sent.",
          }),
        },
      })

      return { ...updated, emailSent: true, emailSkipReason: undefined }
    }),

  createPaymentLink: authorizedProcedure("invoice:send")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
      })

      if (invoice.paymentStatus === "paid" || invoice.status === "paid") {
        invoiceLogger.warn("invoice.payment_link.rejected", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          reason: "already_paid",
        })
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Paid invoices do not need payment links",
        })
      }

      if (invoice.status !== "sent" && invoice.status !== "overdue") {
        invoiceLogger.warn("invoice.payment_link.rejected", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          reason: "invalid_status",
          status: invoice.status,
        })
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only sent or overdue invoices can create payment links",
        })
      }

      const settings = await prisma.orgSettings.findUnique({
        where: { organizationId: ctx.organizationId },
        select: {
          stripePublishableKey: true,
          stripeSecretKeyEnc: true,
          stripeWebhookSecretEnc: true,
        },
      })

      if (
        !getStripePaymentConfigurationState({
          stripePublishableKey: settings?.stripePublishableKey ?? null,
          stripeSecretKeyEnc: settings?.stripeSecretKeyEnc ?? null,
          stripeWebhookSecretEnc: settings?.stripeWebhookSecretEnc ?? null,
        }).configured
      ) {
        invoiceLogger.warn("invoice.payment_link.rejected", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          reason: "stripe_not_configured",
        })
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Stripe payment links are not configured for this organization",
        })
      }

      const issuedAt = invoice.publicPaymentIssuedAt ?? new Date()
      const updated = await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          publicPaymentIssuedAt: issuedAt,
        },
      })

      const url = getPublicInvoicePaymentUrl(updated)
      if (!url) {
        invoiceLogger.error("invoice.payment_link.failed", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
        })
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create payment link",
        })
      }

      invoiceLogger.info("invoice.payment_link.created", {
        organizationId: ctx.organizationId,
        invoiceId: invoice.id,
        publicPaymentIssuedAt: issuedAt,
      })

      return { url }
    }),

  markOverdue: authorizedProcedure("invoice:update").mutation(async ({ ctx }) => {
    const { count } = await prisma.invoice.updateMany({
      where: {
        organizationId: ctx.organizationId,
        status: { in: ["sent", "viewed"] },
        dueDate: { lt: new Date() },
      },
      data: { status: "overdue" },
    })
    return { count }
  }),

  markPaid: authorizedProcedure("payment:create")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
      })

      if (invoice.status !== "sent" && invoice.status !== "overdue") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only sent or overdue invoices can be marked as paid",
        })
      }

      return prisma.invoice.update({
        where: { id: input.id },
        data: {
          status: "paid",
          paymentStatus: "paid",
          paidAt: new Date(),
        },
      })
    }),
})
