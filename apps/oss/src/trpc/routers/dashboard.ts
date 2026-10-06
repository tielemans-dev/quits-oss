import { router, authorizedProcedure } from "../init"
import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { computeSettlement } from "../../domain/documents/settlement"

export const dashboardRouter = router({
  stats: authorizedProcedure("invoice:read").query(async ({ ctx }) => {
    const [totalRevenue, outstanding, overdueCount, totalContacts, recentInvoices] =
      await Promise.all([
        // Money actually received, including partial payments on open invoices.
        prisma.payment.aggregate({
          where: { organizationId: ctx.organizationId, voidedAt: null },
          _sum: { amount: true },
        }),
        // What customers still owe on open invoices, after payments and credit notes.
        prisma.invoice.findMany({
          where: {
            organizationId: ctx.organizationId,
            status: { in: ["sent", "viewed"] },
          },
          select: { totalGross: true, amountPaid: true, amountCredited: true },
        }),
        prisma.invoice.count({
          where: { organizationId: ctx.organizationId, status: "overdue" },
        }),
        prisma.contact.count({
          where: { organizationId: ctx.organizationId },
        }),
        prisma.invoice.findMany({
          where: { organizationId: ctx.organizationId },
          include: { contact: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
      ])

    return {
      totalRevenue: totalRevenue._sum.amount?.toNumber() ?? 0,
      outstanding: outstanding
        .reduce(
          (sum, invoice) => sum.plus(computeSettlement(invoice).balanceDue),
          new Prisma.Decimal(0)
        )
        .toNumber(),
      overdueCount,
      totalContacts,
      recentInvoices: recentInvoices.map((inv) => ({
        id: inv.id,
        number: inv.number,
        contactName: inv.contact.name,
        total: inv.totalGross.toNumber(),
        currency: inv.currency,
        status: inv.status,
        paymentStatus: inv.paymentStatus,
        balanceDue: computeSettlement(inv).balanceDue.toNumber(),
        issueDate: inv.issueDate.toISOString(),
        dueDate: inv.dueDate.toISOString(),
      })),
    }
  }),
})
