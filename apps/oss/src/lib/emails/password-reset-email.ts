import { actionBlock, composeMessage, deliver, escapeHtml, fromAddress, layout, sanitizeHeader, t } from "../email"
import type { DeliveryOptions } from "../email"
import { PASSWORD_RESET_EXPIRES_IN } from "../auth/password-policy"

export type PasswordResetEmailInput = {
  to: string
  name: string
  resetUrl: string
  fromEmail?: string
  locale?: string | null
}

export function buildPasswordResetEmailContent({ name, resetUrl, fromEmail, locale }: Omit<PasswordResetEmailInput, "to">) {
  const url = new URL(resetUrl)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Invalid password reset URL")
  }
  return {
    subject: sanitizeHeader(t("email.passwordReset.subject", locale)),
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:22px;">${escapeHtml(t("email.passwordReset.title", locale))}</h2>
      <p style="color:#6b7280;">${escapeHtml(t("email.passwordReset.greeting", locale, { name }))}</p>
      <p style="color:#6b7280;">${escapeHtml(t("email.passwordReset.body", locale, { minutes: PASSWORD_RESET_EXPIRES_IN / 60 }))}</p>
      ${actionBlock({ href: resetUrl, label: t("email.passwordReset.action", locale), fallbackLabel: t("email.passwordReset.fallback", locale) })}
      <p style="margin-top:24px;font-size:14px;color:#6b7280;">${escapeHtml(t("email.passwordReset.ignore", locale))}</p>
    `, locale),
    fromAddress: `Quits <${sanitizeHeader(fromEmail?.trim() || fromAddress())}>`,
    replyTo: null,
  }
}

export async function sendPasswordResetEmail({ to, ...input }: PasswordResetEmailInput, options: DeliveryOptions = {}) {
  return deliver(composeMessage(to, buildPasswordResetEmailContent(input)), options)
}
