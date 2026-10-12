import { createFileRoute } from "@tanstack/react-router"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { LEGACY_ORGANIZATION_HEADER, ORGANIZATION_HEADER } from "../../../lib/organization-request"

async function importRequestDependencies() {
  // Vite's SSR runner can expose unfinished exports when overlapping imports
  // evaluate init and its router dependants concurrently on a cold request.
  const { auth } = await import("../../../lib/auth")
  const { createRequestContext } = await import("../../../trpc/init")
  const { appRouter } = await import("../../../trpc/router")

  return { auth, createRequestContext, appRouter }
}

let dependencyLoad: ReturnType<typeof importRequestDependencies> | undefined

function loadRequestDependencies() {
  // Cold requests share one import chain. Vite can expose unfinished module exports
  // when several request handlers start overlapping SSR imports of the router graph.
  dependencyLoad ??= importRequestDependencies().catch(error => {
    dependencyLoad = undefined
    throw error
  })
  return dependencyLoad
}

async function handleTrpcRequest(request: Request) {
  const { auth, createRequestContext, appRouter } = await loadRequestDependencies()
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: async () => {
      const session = await auth.api.getSession({
        headers: request.headers,
      })
      // The client's intended organization, checked against the session in orgProcedure.
      const requestedOrganizationId =
        (
          request.headers.get(ORGANIZATION_HEADER) ??
          request.headers.get(LEGACY_ORGANIZATION_HEADER)
        )?.trim() || null
      return createRequestContext(session, requestedOrganizationId)
    },
  })
}

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleTrpcRequest(request),
      POST: ({ request }: { request: Request }) => handleTrpcRequest(request),
    },
  },
})
