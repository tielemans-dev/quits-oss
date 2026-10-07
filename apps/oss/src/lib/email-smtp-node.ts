import type { SendMailOptions } from "nodemailer"
import { EmailSendError, type EmailMessage } from "./email"
import { readSmtpConfiguration, type EmailEnvironment } from "./email-provider-config"
import { getRuntimePlatform, getRuntimeEnv } from "./runtime/platform"

/** Nodemailer also labels post-DATA socket errors CONN, so the command alone is not proof. */
export function isSmtpPreSubmissionFailure(error: unknown, phase?: "connection" | "envelope" | "data"): boolean {
  if (!error || typeof error !== "object") return false
  // Each transport sends one message. An observed DATA command permanently marks the
  // submission as uncertain; before it, no message body could have reached the relay.
  if (phase !== undefined) return phase !== "data"
  const smtpError = error as { code?: string; command?: string; syscall?: string; message?: string }
  if (smtpError.code === "ETLS" && (smtpError.command === "STARTTLS" || smtpError.command === "CONN")) return true
  if (smtpError.command !== "CONN") return false
  return smtpError.code === "EDNS"
    || (smtpError.code === "ESOCKET" && smtpError.syscall === "connect")
    || (smtpError.code === "ETIMEDOUT" && (
      // These are generated only by Nodemailer's initial connection and greeting timers.
      // Its later socket timeout is simply "Timeout", even though command is still CONN.
      smtpError.message === "Connection timeout" || smtpError.message === "Greeting never received"
    ))
}

/** Node/Bun only. The computed import keeps socket dependencies out of Worker bundles. */
export async function deliverSmtp(message: EmailMessage, environment: EmailEnvironment = getRuntimeEnv()): Promise<{ id: string }> {
  if (getRuntimePlatform().getRuntimeKind() !== "node") {
    throw new Error("SMTP email delivery requires the Node/Bun runtime")
  }
  const configuration = readSmtpConfiguration(environment)
  const moduleName = "nodemailer"
  const { default: nodemailer } = await import(/* @vite-ignore */ moduleName) as { default: typeof import("nodemailer") }
  let phase: "connection" | "envelope" | "data" = "connection"
  const discardLog = () => {}
  const transport = nodemailer.createTransport({
    ...configuration,
    transactionLog: true,
    // Nodemailer logs commands before writing them to the socket. Never move back from
    // DATA, even if the connection then fails. Store no credentials, addresses or content.
    logger: {
      level: discardLog, trace: discardLog, info: discardLog,
      warn: discardLog, error: discardLog, fatal: discardLog,
      debug(entry: { tnx?: string }, command: string) {
        if (entry.tnx !== "client" || phase === "data") return
        if (command === "DATA") phase = "data"
        else if (command.startsWith("MAIL FROM:")) phase = "envelope"
      },
    },
  })
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
    if (result.accepted.length === 0) {
      throw new EmailSendError("smtp_rejected", "The SMTP server refused all recipients")
    }
    // A mixed outcome does not prove delivery to the intended recipient. A second submission
    // could duplicate the accepted recipients, so the outbox must settle without retrying.
    if (result.rejected.length > 0) {
      throw new EmailSendError("smtp_partial_acceptance", "The SMTP server accepted some recipients and refused others")
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
    if (isSmtpPreSubmissionFailure(error, phase)) {
      throw new EmailSendError("smtp_unavailable", "The SMTP connection failed before message submission, so nothing was delivered")
    }
    throw error
  } finally {
    transport.close()
  }
}
