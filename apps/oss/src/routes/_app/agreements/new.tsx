import { createFileRoute } from "@tanstack/react-router"
import { AgreementEditor } from "./-editor"
export const Route = createFileRoute("/_app/agreements/new")({
  component: () => <AgreementEditor />,
})
