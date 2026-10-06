import { router, authorizedProcedure } from "../init"
import { prisma } from "../../lib/db"

export const dashboardRouter = router({
  stats: authorizedProcedure("invoice:read").query(async ({ ctx }) => {
    const [totalRevenue, outstanding, overdueCount, totalContacts, recentInvoices] =
      await Promise.all([
        prisma.invoice.aggregate({
          where: { organizationId: ctx.organizationId, status: "paid" },
          _sum: { totalGross: true },
        }),
        prisma.invoice.aggregate({
          where: {
            organizationId: ctx.organizationId,
            status: { in: ["sent", "viewed"] },
          },
          _sum: { totalGross: true },
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
      totalRevenue: totalRevenue._sum.totalGross?.toNumber() ?? 0,
      outstanding: outstanding._sum.totalGross?.toNumber() ?? 0,
      overdueCount,
      totalContacts,
      recentInvoices: recentInvoices.map((inv) => ({
        id: inv.id,
        number: inv.number,
        contactName: inv.contact.name,
        total: inv.totalGross.toNumber(),
        currency: inv.currency,
        status: inv.status,
        issueDate: inv.issueDate.toISOString(),
        dueDate: inv.dueDate.toISOString(),
      })),
    }
  }),
})
