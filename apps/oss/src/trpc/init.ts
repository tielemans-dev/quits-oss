import { initTRPC, TRPCError } from "@trpc/server"
import superjson from "superjson"
import { auth } from "../lib/auth"
import { actorCan } from "../domain/actor"
import type { Permission } from "../domain/permissions"
import { resolveUserActor } from "../domain/user-actor"
import { isCloudDistribution } from "../lib/distribution"

export type Context = {
  session: Awaited<ReturnType<typeof auth.api.getSession>> | null
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
})

export const router = t.router
export const publicProcedure = t.procedure
export const setupProcedure = publicProcedure.use(async ({ next }) => {
  if (isCloudDistribution) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Installation setup is disabled in cloud distribution",
    })
  }

  return next()
})

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" })
  }
  return next({
    ctx: {
      session: ctx.session,
      user: ctx.session.user,
      organizationId: ctx.session.session.activeOrganizationId,
    },
  })
})

export const orgProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.organizationId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "No active organization selected",
    })
  }

  const actor = await resolveUserActor({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    userName: ctx.user.name,
    userEmail: ctx.user.email,
  })
  if (!actor) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of the active organization",
    })
  }

  return next({
    ctx: {
      ...ctx,
      organizationId: ctx.organizationId,
      actor,
    },
  })
})

/** An organization procedure that requires one `resource:action` permission. */
export function authorizedProcedure(permission: Permission) {
  return orgProcedure.use(async ({ ctx, next }) => {
    if (!actorCan(ctx.actor, permission)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Your role does not allow ${permission}`,
      })
    }
    return next()
  })
}
