import { initTRPC, TRPCError } from "@trpc/server"
import superjson from "superjson"
import { auth } from "../lib/auth"
import { actorCan } from "../domain/actor"
import type { Permission } from "../domain/permissions"
import { resolveUserActor } from "../domain/user-actor"
import { isCloudDistribution } from "../lib/distribution"
import {
  MIXED_ORGANIZATIONS,
  ORGANIZATION_CHANGED_MESSAGE,
  ORGANIZATION_CHANGED_REASON,
  OrganizationChangedError,
} from "../lib/organization-request"

export type Context = {
  session: Awaited<ReturnType<typeof auth.api.getSession>> | null
  /**
   * The organization the client says it is acting for (the `x-yaip-organization-id` header), if
   * it sent one. Only compared with the session's active organization; never used to authorize.
   */
  requestedOrganizationId?: string | null
}

export { ORGANIZATION_CHANGED_MESSAGE }

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // Lets the client tell "the organization changed" apart from every other CONFLICT.
    const reason = error.cause instanceof OrganizationChangedError ? ORGANIZATION_CHANGED_REASON : null
    return { ...shape, data: { ...shape.data, reason } }
  },
})

/** The error for a request made for another organization than the session's active one. */
function organizationChangedError() {
  return new TRPCError({
    code: "CONFLICT",
    message: ORGANIZATION_CHANGED_MESSAGE,
    cause: new OrganizationChangedError(),
  })
}

/**
 * Rejects a request the client made for another organization than the session's active one, or
 * for several organizations at once (`MIXED_ORGANIZATIONS`, rejected whatever is active). A
 * request that names no organization is accepted. Never grants anything: it only refuses.
 */
export function assertRequestedOrganization(
  requestedOrganizationId: string | null | undefined,
  activeOrganizationId: string | null | undefined
): void {
  if (!requestedOrganizationId) return
  if (requestedOrganizationId === MIXED_ORGANIZATIONS || requestedOrganizationId !== activeOrganizationId) {
    throw organizationChangedError()
  }
}

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
  // A batch made for several organizations is never applied, whatever is active now (or whether
  // any organization is active at all).
  if (ctx.requestedOrganizationId === MIXED_ORGANIZATIONS) throw organizationChangedError()
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

  // A request started while another organization was active must not be applied to this one.
  assertRequestedOrganization(ctx.requestedOrganizationId, ctx.organizationId)

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
