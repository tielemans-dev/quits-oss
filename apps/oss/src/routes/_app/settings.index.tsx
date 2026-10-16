import { createFileRoute, redirect } from "@tanstack/react-router"

import { DEFAULT_SETTINGS_SECTION } from "../../components/shell/settings-nav"

// Settings opens on its first page, the company profile.
export const Route = createFileRoute("/_app/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: DEFAULT_SETTINGS_SECTION }, replace: true })
  },
})
