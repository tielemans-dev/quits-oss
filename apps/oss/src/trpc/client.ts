import { createTRPCClient, httpBatchLink } from "@trpc/client"
import superjson from "superjson"
import { organizationRequestHeaders } from "../lib/active-organization"
import type { AppRouter } from "./router"

function getBaseUrl() {
  if (typeof window !== "undefined") return ""
  return "http://localhost:3000"
}

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${getBaseUrl()}/api/trpc`,
      transformer: superjson,
      // Read when each batch is sent, so a request carries the organization it was made for.
      headers: () => organizationRequestHeaders(),
    }),
  ],
})
