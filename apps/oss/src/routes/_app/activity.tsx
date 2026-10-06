import { createFileRoute } from "@tanstack/react-router"

/** Owned by the exports and audit log feature. */
export const Route = createFileRoute("/_app/activity")({
  component: ActivityPage,
})

function ActivityPage() {
  return null
}
