import { readFileSync } from "node:fs"
import { createServer as createNetServer, type Socket } from "node:net"
import { createSecureContext, createServer as createTlsServer, TLSSocket } from "node:tls"
import type { EmailEnvironment } from "../../lib/email-provider-config"

/** Real relay with a disposable, untrusted certificate. Never disables TLS validation. */
export async function withUntrustedSmtpTls(
  mode: "starttls" | "implicit",
  run: (environment: EmailEnvironment, commands: string[]) => Promise<void>
) {
  const tls = {
    key: readFileSync(new URL("./fixtures/smtp/key.pem", import.meta.url)),
    cert: readFileSync(new URL("./fixtures/smtp/cert.pem", import.meta.url)),
  }
  const commands: string[] = []
  const sockets = new Set<Socket>()
  function track(socket: Socket) {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => sockets.delete(socket))
  }
  const server = mode === "implicit" ? createTlsServer(tls) : createNetServer((socket) => {
    socket.write("220 local.test ESMTP\r\n")
    let buffered = ""
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString()
      for (;;) {
        const end = buffered.indexOf("\r\n")
        if (end < 0) return
        const command = buffered.slice(0, end)
        buffered = buffered.slice(end + 2)
        commands.push(command)
        if (/^EHLO/i.test(command)) socket.write("250-local.test\r\n250 STARTTLS\r\n")
        else if (command === "STARTTLS") {
          socket.write("220 Begin TLS\r\n")
          socket.off("data", onData)
          const secureSocket = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext(tls) })
          track(secureSocket)
          return
        } else socket.write("250 OK\r\n")
      }
    }
    socket.on("data", onData)
  })
  server.on("connection", track)
  server.on("tlsClientError", () => {})
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a local relay port")
  try {
    await run({
      EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(address.port),
      SMTP_SECURE: String(mode === "implicit"), SMTP_REQUIRE_TLS: "true",
    }, commands)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
