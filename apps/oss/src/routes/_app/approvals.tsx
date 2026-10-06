import { createFileRoute } from "@tanstack/react-router"

/** Owned by the agent API feature. */
export const Route = createFileRoute("/_app/approvals")({
  component: ApprovalsPage,
})

function ApprovalsPage() {
  return null
}
