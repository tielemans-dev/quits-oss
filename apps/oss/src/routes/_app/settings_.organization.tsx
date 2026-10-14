import { createFileRoute, redirect } from "@tanstack/react-router"

// Organization settings live in the app's existing Settings form.
export const Route = createFileRoute("/_app/settings_/organization")({
  beforeLoad: () => { throw redirect({ to: "/settings", replace: true }) },
})
