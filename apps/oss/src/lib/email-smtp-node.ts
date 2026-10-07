import type { SendMailOptions } from "nodemailer"
import { EmailSendError, type EmailMessage } from "./email"
import { readSmtpConfiguration } from "./email-provider-config"
import { getRuntimePlatform } from "./runtime/platform"

/** Node/Bun only. The computed import keeps socket dependencies out of Worker bundles. */
export async function deliverSmtp(message: EmailMessage): Promise<{ id: string }> {
  if (getRuntimePlatform().getRuntimeKind() !== "node") {
    throw new Error("SMTP email delivery requires the Node/Bun runtime")
  }
  const configuration = readSmtpConfiguration()
  const moduleName = "nodemailer"
  const { default: nodemailer } = await import(/* @vite-ignore */ moduleName) as { default: typeof import("nodemailer") }
  const transport = nodemailer.createTransport(configuration)
  try {
    if (message.react || (!message.html && !message.text)) {
      throw new EmailSendError("smtp_unsupported_content", "SMTP email requires rendered HTML or text")
    }
    const options: SendMailOptions = {
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      replyTo: message.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
      attachments: message.attachments?.map((attachment) => {
        if (attachment.path) {
          throw new EmailSendError("smtp_unsupported_attachment", "SMTP attachments must contain inline content")
        }
        return {
          filename: attachment.filename,
          content: attachment.content,
          ...(typeof attachment.content === "string" ? { encoding: "base64" } : {}),
          contentType: attachment.contentType,
          cid: attachment.contentId,
        }
      }),
    }
    const result = await transport.sendMail(options)
    // SMTP may accept some recipients and reject others. A retry could duplicate the accepted
    // recipients, so any acceptance is recorded as delivered. Quits document emails have one.
    if (result.accepted.length === 0) {
      throw new EmailSendError("smtp_rejected", "The SMTP server refused all recipients")
    }
    return { id: result.messageId }
  } catch (error) {
    if (error instanceof EmailSendError) throw error
    const smtpError = error as { responseCode?: number }
    // A completed negative SMTP response proves this submission was refused. A connection
    // loss or timeout may occur after DATA was accepted and must remain unconfirmed.
    if (smtpError.responseCode && smtpError.responseCode >= 400 && smtpError.responseCode <= 599) {
      throw new EmailSendError("smtp_rejected", `SMTP server refused delivery (${smtpError.responseCode})`)
    }
    throw error
  } finally {
    transport.close()
  }
}
