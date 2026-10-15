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
  const { getRuntimeCapabilities } = await import("../../../lib/runtime/extensions")
  if (request.method === "POST" && getRuntimeCapabilities().sellerVatConfirmation.enabled) {
    // Settings permits a 2 MB logo; still bound the entire streamed body before JSON parsing.
    const reader = request.clone().body?.getReader()
    let size = 0
    try {
      if (reader) for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 4_194_304) { void reader.cancel(); void request.body?.cancel(); return new Response(null, { status: 413 }) }
      }
    } finally { reader?.releaseLock() }
  }
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
      const requestedOrganizationId = (request.headers.get(ORGANIZATION_HEADER) ?? request.headers.get(LEGACY_ORGANIZATION_HEADER))?.trim() || null
      return createRequestContext(session, requestedOrganizationId, { url: request.url, headers: request.headers, signal: request.signal })
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
