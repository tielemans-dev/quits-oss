import { createTRPCClient, httpBatchLink, type TRPCLink } from "@trpc/client"
import type { AnyRouter } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import superjson from "superjson"
import { getRequestOrganizationId, markOrganizationChanged } from "../lib/active-organization"
import { isOrganizationChangedError, organizationRequestHeaders } from "../lib/organization-request"
import type { AppRouter } from "./router"

function getBaseUrl() {
  if (typeof window !== "undefined") return ""
  return "http://localhost:3000"
}

/** Operation context key holding the organization an operation was made for. */
const ORGANIZATION_CONTEXT_KEY = "quitsOrganizationId"

function operationOrganizationId(context: Record<string, unknown>): string | null {
  const value = context[ORGANIZATION_CONTEXT_KEY]
  return typeof value === "string" ? value : null
}

/**
 * Stamps every operation with the organization the UI acts for when the operation is made.
 * Batches are sent later, so reading the organization then could send an operation made for one
 * organization for another one that was switched to in between.
 */
export function organizationStampLink<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        const organizationId = getRequestOrganizationId()
        return next({ ...op, context: { ...op.context, [ORGANIZATION_CONTEXT_KEY]: organizationId } }).subscribe(
          observer
        )
      })
}

/**
 * Notices when the server rejected an operation because the session's active organization is no
 * longer the one this tab acts for (it was switched in another tab), so the app layout can ask to
 * reload. Every other error, including other `CONFLICT`s, passes through untouched.
 */
export function organizationChangedLink<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  return () =>
    ({ op, next }) =>
      observable((observer) =>
        next(op).subscribe({
          next: (value) => observer.next(value),
          error: (error) => {
            if (isOrganizationChangedError(error)) markOrganizationChanged()
            observer.error(error)
          },
          complete: () => observer.complete(),
        })
      )
}

export type TrpcClientOptions = {
  url?: string
  fetch?: typeof fetch
}

export function createAppTrpcClient(options: TrpcClientOptions = {}) {
  return createTRPCClient<AppRouter>({
    links: [
      organizationChangedLink<AppRouter>(),
      organizationStampLink<AppRouter>(),
      httpBatchLink({
        url: options.url ?? `${getBaseUrl()}/api/trpc`,
        transformer: superjson,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        // The organizations the batched operations were made for, not the one active now.
        headers: ({ opList }) => organizationRequestHeaders(opList.map((op) => operationOrganizationId(op.context))),
      }),
    ],
  })
}

export const trpc = createAppTrpcClient()
