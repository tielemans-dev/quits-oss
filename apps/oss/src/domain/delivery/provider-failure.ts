import { z } from "zod"

/** Safe classifications only: never transport a provider's free-form error or provider code. */
export const emailProviderFailureCodeSchema = z.enum(["email_provider_refused", "email_provider_unreachable"])
export type EmailProviderFailureCode = z.infer<typeof emailProviderFailureCodeSchema>

export function emailProviderFailureMessage(code: EmailProviderFailureCode = "email_provider_refused") {
  return code === "email_provider_unreachable"
    ? "The email provider could not be reached. Check the email configuration."
    : "The email provider refused the email. Check the email configuration."
}
