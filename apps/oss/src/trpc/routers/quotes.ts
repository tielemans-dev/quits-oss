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
import { sendQuoteEmail } from "../../lib/email"
import { assertCloudOnboardingComplete } from "../../lib/onboarding/guard"
import { appLogger } from "../../lib/observability"
import { toNullableJsonInput } from "../../lib/prisma-json"
import { getPublicQuoteUrl } from "../../lib/quotes/public-url"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { router, orgProcedure } from "../init"

const quoteLogger = appLogger.child("quotes")

const isoDateSchema = z.string().refine(
  (value) => !Number.isNaN(new Date(value).getTime()),
  "Invalid date"
)

const currencyCodeSchema = z.string().trim().regex(/^[A-Z]{3}$/)

const quoteLineItemInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(1_000_000),
  unitPrice: z.number().min(0).max(1_000_000_000),
})

const emailAddressSchema = z.string().trim().email()

function mapQuoteItemForUi(item: {
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

export const quotesRouter = router({
  list: orgProcedure
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

      const quotes = await prisma.quote.findMany({
        where,
        include: { contact: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      })

      return quotes.map((quote) => ({
        ...quote,
        subtotal: quote.subtotalNet.toNumber(),
        taxAmount: quote.totalTax.toNumber(),
        total: quote.totalGross.toNumber(),
      }))
    }),

  get: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const quote = await prisma.quote.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
          invoices: { select: { id: true, number: true } },
        },
      })

      return {
        ...quote,
        subtotal: quote.subtotalNet.toNumber(),
        taxAmount: quote.totalTax.toNumber(),
        total: quote.totalGross.toNumber(),
        publicViewUrl: getPublicQuoteUrl(quote),
        items: quote.items.map((item) => ({
          ...item,
          ...mapQuoteItemForUi(item),
        })),
      }
    }),

  create: orgProcedure
    .input(
      z.object({
        contactId: z.string().trim().min(1),
        expiryDate: isoDateSchema,
        currency: currencyCodeSchema.optional(),
        notes: z.string().trim().max(5000).optional(),
        taxRate: z.number().min(0).max(100).default(0),
        items: z.array(quoteLineItemInputSchema).min(1).max(100),
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

        const num = settings.quoteNextNum
        const quoteNumber = `${settings.quotePrefix}-${String(num).padStart(4, "0")}`
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

        const quote = await tx.quote.create({
          data: {
            organizationId: ctx.organizationId,
            contactId: input.contactId,
            number: quoteNumber,
            status: "draft",
            expiryDate: new Date(input.expiryDate),
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
          data: { quoteNextNum: num + 1 },
        })

        return quote
      })

      return {
        ...result,
        subtotal: result.subtotalNet.toNumber(),
        taxAmount: result.totalTax.toNumber(),
        total: result.totalGross.toNumber(),
        items: result.items.map((item) => ({
          ...item,
          ...mapQuoteItemForUi(item),
        })),
      }
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        contactId: z.string().trim().min(1).optional(),
        expiryDate: isoDateSchema.optional(),
        currency: currencyCodeSchema.optional(),
        notes: z.string().trim().max(5000).optional(),
        taxRate: z.number().min(0).max(100).optional(),
        items: z.array(quoteLineItemInputSchema).min(1).max(100).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.quote.findFirstOrThrow({
          where: { id: input.id, organizationId: ctx.organizationId },
        })

        if (existing.status !== "draft") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Only draft quotes can be edited",
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
        if (input.expiryDate) updateData.expiryDate = new Date(input.expiryDate)
        if (input.currency) updateData.currency = input.currency
        if (input.notes !== undefined) updateData.notes = input.notes

        if (input.items) {
          await tx.quoteItem.deleteMany({ where: { quoteId: input.id } })

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

          await tx.quoteItem.createMany({
            data: totals.lines.map((line, index) => ({
              quoteId: input.id,
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
          const items = await tx.quoteItem.findMany({
            where: { quoteId: input.id },
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
              return tx.quoteItem.update({
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

        return tx.quote.update({
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
          ...mapQuoteItemForUi(item),
        })),
      }
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const quote = await prisma.quote.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
      })

      if (quote.status !== "draft") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only draft quotes can be deleted",
        })
      }

      return prisma.quote.delete({
        where: { id: input.id },
      })
    }),

  send: orgProcedure
    .input(
      z.object({
        id: z.string(),
        allowSendWithoutEmail: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const quote = await prisma.quote.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
        },
      })

      if (quote.status !== "draft") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only draft quotes can be sent",
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
      const profile = resolveCountryProfile(orgSettings?.countryCode ?? quote.countryCode)
      const sellerTaxIds = await prisma.organizationTaxId.findMany({
        where: { organizationId: ctx.organizationId },
        select: { scheme: true, value: true, countryCode: true },
      })

      const taxRate = quote.subtotalNet.toNumber() > 0
        ? (quote.totalTax.toNumber() / quote.subtotalNet.toNumber()) * 100
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
      const publicAccessIssuedAt = quote.publicAccessIssuedAt ?? sentAt
      const publicQuoteUrl = getPublicQuoteUrl({
        id: quote.id,
        status: "sent",
        publicAccessIssuedAt,
        publicAccessKeyVersion: quote.publicAccessKeyVersion,
      })
      const emailDelivery = getEmailDeliveryRuntimeStatus({
        managed: getRuntimeCapabilities().emailDelivery.managed,
        resendApiKey: process.env.RESEND_API_KEY,
        fromEmail: process.env.FROM_EMAIL,
      })
      const contactEmail = quote.contact.email?.trim() ?? ""
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
        quoteLogger.warn("quote.email.skipped", {
          organizationId: ctx.organizationId,
          quoteId: quote.id,
          reason: "provider_missing",
        })
        const updated = await prisma.quote.update({
          where: { id: input.id },
          data: {
            status: "sent",
            issueDate: sentAt,
            publicAccessIssuedAt,
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
        await sendQuoteEmail({
          to: contactEmail,
          fromName: envelope.fromName,
          fromEmail: envelope.fromEmail,
          replyTo: envelope.replyTo,
          quote: {
            ...quote,
            issueDate: sentAt,
            subtotal: quote.subtotalNet.toNumber(),
            taxAmount: quote.totalTax.toNumber(),
            total: quote.totalGross.toNumber(),
            items: quote.items.map((i) => ({
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
          contactName: quote.contact.name,
          publicQuoteUrl,
        })
        emailSent = true
        quoteLogger.info("quote.email.sent", {
          organizationId: ctx.organizationId,
          quoteId: quote.id,
          usingBrandedDomain: envelope.usingBrandedDomain,
          hasPublicQuoteUrl: Boolean(publicQuoteUrl),
        })
      } catch (error) {
        quoteLogger.error("quote.email.failed", {
          organizationId: ctx.organizationId,
          quoteId: quote.id,
          error,
        })
        await prisma.quote.update({
          where: { id: input.id },
          data: {
            ...createEmailDeliveryAttempt({
              outcome: "failed",
              code: "send_failed",
              message: "Failed to send quote email.",
            }),
          },
        })
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to send quote email. Quote was not marked as sent.",
        })
      }

      const updated = await prisma.quote.update({
        where: { id: input.id },
        data: {
          status: "sent",
          issueDate: sentAt,
          publicAccessIssuedAt,
          ...createEmailDeliveryAttempt({
            at: sentAt,
            outcome: "sent",
            code: "sent",
            message: "Quote email sent.",
          }),
        },
      })

      return { ...updated, emailSent, emailSkipReason }
    }),

  resendEmail: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const quote = await prisma.quote.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
        },
      })

      if (!["sent", "accepted", "rejected"].includes(quote.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only shared quotes can be resent by email",
        })
      }

      const publicQuoteUrl = getPublicQuoteUrl(quote)
      if (!publicQuoteUrl) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Quote has no public link to resend",
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
      const emailDelivery = getEmailDeliveryRuntimeStatus({
        managed: getRuntimeCapabilities().emailDelivery.managed,
        resendApiKey: process.env.RESEND_API_KEY,
        fromEmail: process.env.FROM_EMAIL,
      })
      const contactEmail = quote.contact.email?.trim() ?? ""

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
        await sendQuoteEmail({
          to: contactEmail,
          fromName: envelope.fromName,
          fromEmail: envelope.fromEmail,
          replyTo: envelope.replyTo,
          quote: {
            ...quote,
            subtotal: quote.subtotalNet.toNumber(),
            taxAmount: quote.totalTax.toNumber(),
            total: quote.totalGross.toNumber(),
            items: quote.items.map((i) => ({
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
          contactName: quote.contact.name,
          publicQuoteUrl,
        })
        quoteLogger.info("quote.email.resent", {
          organizationId: ctx.organizationId,
          quoteId: quote.id,
          usingBrandedDomain: envelope.usingBrandedDomain,
          hasPublicQuoteUrl: Boolean(publicQuoteUrl),
        })
      } catch (error) {
        quoteLogger.error("quote.email.resend_failed", {
          organizationId: ctx.organizationId,
          quoteId: quote.id,
          error,
        })
        await prisma.quote.update({
          where: { id: input.id },
          data: {
            ...createEmailDeliveryAttempt({
              outcome: "failed",
              code: "send_failed",
              message: "Failed to send quote email.",
            }),
          },
        })
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to resend quote email.",
        })
      }

      const updated = await prisma.quote.update({
        where: { id: input.id },
        data: {
          ...createEmailDeliveryAttempt({
            outcome: "sent",
            code: "sent",
            message: "Quote email sent.",
          }),
        },
      })

      return { ...updated, emailSent: true, emailSkipReason: undefined }
    }),

  reject: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const quote = await prisma.quote.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
      })

      if (quote.status !== "sent") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only sent quotes can be rejected",
        })
      }

      return prisma.quote.update({
        where: { id: input.id },
        data: { status: "rejected" },
      })
    }),

  convertToInvoice: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.$transaction(async (tx) => {
        const quote = await tx.quote.findFirstOrThrow({
          where: { id: input.id, organizationId: ctx.organizationId },
          include: {
            items: { orderBy: { sortOrder: "asc" } },
          },
        })

        if (quote.status !== "accepted") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Only accepted quotes can be converted to invoices",
          })
        }

        let settings = await tx.orgSettings.findUnique({
          where: { organizationId: ctx.organizationId },
        })
        if (!settings) {
          settings = await tx.orgSettings.create({
            data: { organizationId: ctx.organizationId },
          })
        }

        const num = settings.invoiceNextNum
        const invoiceNumber = `${settings.invoicePrefix}-${String(num).padStart(4, "0")}`

        const invoice = await tx.invoice.create({
          data: {
            organizationId: ctx.organizationId,
            contactId: quote.contactId,
            number: invoiceNumber,
            status: "draft",
            dueDate: quote.expiryDate,
            supplyDate: quote.supplyDate,
            subtotalNet: quote.subtotalNet.toNumber(),
            totalTax: quote.totalTax.toNumber(),
            totalGross: quote.totalGross.toNumber(),
            currency: quote.currency,
            countryCode: quote.countryCode,
            locale: quote.locale,
            timezone: quote.timezone,
            taxRegime: quote.taxRegime,
            pricesIncludeTax: quote.pricesIncludeTax,
            sellerSnapshot: toNullableJsonInput(quote.sellerSnapshot),
            buyerSnapshot: toNullableJsonInput(quote.buyerSnapshot),
            complianceStatus: quote.complianceStatus,
            complianceErrors: toNullableJsonInput(quote.complianceErrors),
            legalText: toNullableJsonInput(quote.legalText),
            paymentReference: quote.paymentReference,
            purchaseOrderRef: quote.purchaseOrderRef,
            notes: quote.notes,
            quoteId: quote.id,
            items: {
              create: quote.items.map((item) => ({
                description: item.description,
                quantity: item.quantity.toNumber(),
                unitPriceNet: item.unitPriceNet.toNumber(),
                unitPriceGross: item.unitPriceGross.toNumber(),
                lineNet: item.lineNet.toNumber(),
                lineTax: item.lineTax.toNumber(),
                lineGross: item.lineGross.toNumber(),
                taxRate: item.taxRate.toNumber(),
                taxCategory: item.taxCategory,
                taxCode: item.taxCode,
                sortOrder: item.sortOrder,
              })),
            },
          },
          include: {
            items: true,
          },
        })

        await tx.orgSettings.update({
          where: { organizationId: ctx.organizationId },
          data: { invoiceNextNum: num + 1 },
        })

        await tx.quote.update({
          where: { id: quote.id },
          data: { status: "accepted" },
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
          ...mapQuoteItemForUi(item),
        })),
      }
    }),
})
