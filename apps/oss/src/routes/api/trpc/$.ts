import { createFileRoute } from "@tanstack/react-router"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { LEGACY_ORGANIZATION_HEADER, ORGANIZATION_HEADER } from "../../../lib/organization-request"

async function handleTrpcRequest(request: Request) {
  // Vite's SSR runner can expose unfinished exports when overlapping imports
  // evaluate init and its router dependants concurrently on a cold request.
  const { auth } = await import("../../../lib/auth")
  const { createRequestContext } = await import("../../../trpc/init")
  const { appRouter } = await import("../../../trpc/router")

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
