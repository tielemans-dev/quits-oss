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

/** The settled-state callbacks of one subscriber to a shared query. */
type QuerySubscriber = {
  next: (value: unknown) => void
  error: (error: unknown) => void
  complete: () => void
}

/**
 * Shares one in-flight request between identical concurrent queries. Layouts and pages each fetch
 * the same data on mount (for example the organization settings), so without this every page load
 * sent the same query several times. Only operations still in flight are shared: once a query has
 * completed, the next one is sent as usual, so results are never reused across mutations.
 * Operations are keyed by procedure, input and organization, so different organizations never share.
 */
export function dedupeQueriesLink<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  const inFlight = new Map<string, { subscribers: Set<QuerySubscriber>; unsubscribe?: () => void }>()

  return () =>
    ({ op, next }) =>
      observable((observer) => {
        if (op.type !== "query") {
          return next(op).subscribe(observer)
        }

        const key = JSON.stringify([
          op.path,
          superjson.stringify(op.input),
          operationOrganizationId(op.context),
        ])
        const subscriber: QuerySubscriber = {
          next: (value) => observer.next(value as Parameters<typeof observer.next>[0]),
          error: (error) => observer.error(error as Parameters<typeof observer.error>[0]),
          complete: () => observer.complete(),
        }

        const existing = inFlight.get(key)
        if (existing) {
          existing.subscribers.add(subscriber)
          return () => {
            existing.subscribers.delete(subscriber)
            if (existing.subscribers.size === 0) {
              existing.unsubscribe?.()
              if (inFlight.get(key) === existing) inFlight.delete(key)
            }
          }
        }

        const shared = { subscribers: new Set([subscriber]), unsubscribe: undefined as (() => void) | undefined }
        inFlight.set(key, shared)
        const settle = (notify: (subscriber: QuerySubscriber) => void) => {
          if (inFlight.get(key) === shared) inFlight.delete(key)
          for (const subscriber of shared.subscribers) notify(subscriber)
        }
        const subscription = next(op).subscribe({
          next: (value) => {
            for (const subscriber of shared.subscribers) subscriber.next(value)
          },
          error: (error) => settle((subscriber) => subscriber.error(error)),
          complete: () => settle((subscriber) => subscriber.complete()),
        })
        shared.unsubscribe = () => subscription.unsubscribe()
        return () => {
          shared.subscribers.delete(subscriber)
          if (shared.subscribers.size === 0) {
            shared.unsubscribe?.()
            if (inFlight.get(key) === shared) inFlight.delete(key)
          }
        }
      })
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
      dedupeQueriesLink<AppRouter>(),
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
