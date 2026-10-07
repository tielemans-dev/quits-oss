import { createFileRoute } from "@tanstack/react-router"
import { AgreementEditor } from "./-editor"
export const Route = createFileRoute("/_app/agreements/$agreementId_/edit")({
  component: EditAgreement,
})
function EditAgreement() {
  const { agreementId } = Route.useParams()
  return <AgreementEditor agreementId={agreementId} />
}
