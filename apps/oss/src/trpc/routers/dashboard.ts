import { dashboardSummarySchema } from "@quits/contracts/dashboard"
import { dashboardSummary, moneyReceived } from "../../lib/dashboard/summary"
import { router, authorizedProcedure } from "../init"
import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { computeSettlement } from "../../domain/documents/settlement"
import { requireCurrencyExponent } from "@quits/shared/currency"

export const dashboardRouter = router({
  summary: authorizedProcedure("invoice:read").output(dashboardSummarySchema)
    .query(({ ctx }) => dashboardSummary(prisma, ctx.actor)),
  stats: authorizedProcedure("invoice:read").query(async ({ ctx }) => {
    // Select only what the aggregation and the recent-invoice rows read. Invoice rows carry
    // large JSON snapshots that this query never uses.
    const [received, invoices, totalContacts, recentInvoices, settings] = await Promise.all([
      moneyReceived(prisma, ctx.organizationId, "UTC", null, new Date()),
      prisma.invoice.findMany({
        where: { organizationId: ctx.organizationId, status: { not: "draft" } },
        select: {
          currency: true,
          status: true,
          valuation: true,
          totalGross: true,
          amountPaid: true,
          amountCredited: true,
          creditNotes: { where: { status: "issued" }, select: { valuation: true } },
        },
      }),
      prisma.contact.count({ where: { organizationId: ctx.organizationId } }),
      prisma.invoice.findMany({
        where: { organizationId: ctx.organizationId },
        select: {
          id: true,
          number: true,
          currency: true,
          status: true,
          paymentStatus: true,
          totalGross: true,
          amountPaid: true,
          amountCredited: true,
          issueDate: true,
          dueDate: true,
          contact: { select: { name: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 10,
      }),
      prisma.orgSettings.findUnique({ where: { organizationId: ctx.organizationId }, select: { baseCurrency: true } }),
    ])
    const buckets = new Map<string, { revenue: Prisma.Decimal; outstanding: Prisma.Decimal }>()
    const bucket = (currency: string) => {
      if (!buckets.has(currency)) buckets.set(currency, { revenue: new Prisma.Decimal(0), outstanding: new Prisma.Decimal(0) })
      return buckets.get(currency)!
    }
    // All-time cash sums the monthly subtotals; their grouping timezone cannot change that sum.
    for (const receipt of received) {
      const b = bucket(receipt.currency)
      b.revenue = b.revenue.plus(receipt.amount)
    }
    const baseCurrency = settings?.baseCurrency ?? "USD"
    let baseMinor = new Prisma.Decimal(0), excludedUnknownValuations = 0
    type Valuation = { base: { minor: string | null; currency: string }; rateSource: string }
    for (const invoice of invoices) {
      const b = bucket(invoice.currency)
      if (["sent", "viewed", "overdue"].includes(invoice.status)) {
        b.outstanding = b.outstanding.plus(computeSettlement(invoice).balanceDue)
      }
      const valuations = [invoice.valuation, ...invoice.creditNotes.map(note => note.valuation)] as Array<Valuation | null>
      if (valuations.some(value => !value || value.rateSource === "unknown" || value.base.minor === null || value.base.currency !== baseCurrency)) { excludedUnknownValuations++; continue }
      baseMinor = baseMinor.plus(valuations[0]!.base.minor!).minus(valuations.slice(1).reduce((sum, value) => sum.plus(value!.base.minor!), new Prisma.Decimal(0)))
    }
    const currencyBuckets = [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, totalRevenue: value.revenue.toFixed(), outstanding: value.outstanding.toFixed() }))
    return {
      currencyBuckets,
      // Transitional single-currency clients can still read these without ever summing currencies.
      totalRevenue: currencyBuckets.length <= 1 ? Number(currencyBuckets[0]?.totalRevenue ?? 0) : null,
      outstanding: currencyBuckets.length <= 1 ? Number(currencyBuckets[0]?.outstanding ?? 0) : null,
      baseTotal: { currency: baseCurrency, amount: baseMinor.div(new Prisma.Decimal(10).pow(requireCurrencyExponent(baseCurrency))).toFixed(requireCurrencyExponent(baseCurrency)), excludedUnknownValuations },
      overdueCount: invoices.filter(invoice => invoice.status === "overdue").length,
      totalContacts,
      recentInvoices: recentInvoices.map(inv => ({ id: inv.id, number: inv.number, contactName: inv.contact.name, total: inv.totalGross.toNumber(), currency: inv.currency, status: inv.status, paymentStatus: inv.paymentStatus, balanceDue: computeSettlement(inv).balanceDue.toNumber(), issueDate: inv.issueDate.toISOString(), dueDate: inv.dueDate.toISOString() })),
    }
  }),
})
