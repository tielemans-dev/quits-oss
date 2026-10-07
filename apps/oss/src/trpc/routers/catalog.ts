import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { prisma } from "../../lib/db"
import { authorizedProcedure, router } from "../init"

const catalogItemCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  defaultUnitPrice: z.number().min(0).max(1_000_000_000),
})

const catalogItemUpdateSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  defaultUnitPrice: z.number().min(0).max(1_000_000_000),
})

function mapCatalogItemForUi(item: {
  id: string
  name: string
  description: string | null
  defaultUnitPrice: { toNumber: () => number }
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    defaultUnitPrice: item.defaultUnitPrice.toNumber(),
    isActive: item.isActive,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

export const catalogRouter = router({
  list: authorizedProcedure("catalog:read").query(async ({ ctx }) => {
    const items = await prisma.catalogItem.findMany({
      where: { organizationId: ctx.organizationId, isActive: true },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    })

    return items.map((item) => mapCatalogItemForUi(item))
  }),

  create: authorizedProcedure("catalog:create")
    .input(catalogItemCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const created = await prisma.catalogItem.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          description: input.description || null,
          defaultUnitPrice: input.defaultUnitPrice,
        },
      })

      return mapCatalogItemForUi(created)
    }),

  update: authorizedProcedure("catalog:update")
    .input(catalogItemUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.catalogItem.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId, isActive: true },
        select: { id: true },
      })
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Catalog item not found",
        })
      }

      const updated = await prisma.catalogItem.update({
        where: { id: input.id },
        data: {
          name: input.name,
          description: input.description || null,
          defaultUnitPrice: input.defaultUnitPrice,
        },
      })

      return mapCatalogItemForUi(updated)
    }),

  archive: authorizedProcedure("catalog:update")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.catalogItem.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId, isActive: true },
        select: { id: true },
      })
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Catalog item not found",
        })
      }

      const archived = await prisma.catalogItem.update({
        where: { id: input.id },
        data: { isActive: false },
      })

      return mapCatalogItemForUi(archived)
    }),
})
