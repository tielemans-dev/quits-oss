import { createFileRoute } from "@tanstack/react-router"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { ORGANIZATION_HEADER } from "../../../lib/organization-request"

async function handleTrpcRequest(request: Request) {
  const [{ appRouter }, { auth }] = await Promise.all([
    import("../../../trpc/router"),
    import("../../../lib/auth"),
  ])

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: async () => {
      const session = await auth.api.getSession({
        headers: request.headers,
      })
      // The client's intended organization, checked against the session in orgProcedure.
      const requestedOrganizationId = request.headers.get(ORGANIZATION_HEADER)?.trim() || null
      return { session, requestedOrganizationId }
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
