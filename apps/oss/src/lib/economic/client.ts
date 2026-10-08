import { createHash } from "node:crypto"

export const API_VERSIONS = { rest: "unversioned", entries: "6.0.0", documents: "4.0.1" } as const
const origins = {
  rest: "https://restapi.e-conomic.com/",
  entries: "https://apis.e-conomic.com/bookedEntriesapi/v6.0.0/",
  documents: "https://apis.e-conomic.com/documentsapi/v4.0.1/",
} as const
export type Surface = keyof typeof origins
export type Credentials = { appSecret: string; grantToken: string }
export type FailureCode = "unsafe_link" | "revoked" | "missing_role" | "no_access" | "not_found" | "provider_unavailable" | "invalid_response" | "limit_exceeded" | "source_drift" | "duplicate_identity" | "stale_connection" | "forbidden" | "writeback_disabled" | "account_mismatch" | "operation_conflict"
export class EconomicError extends Error {
  constructor(readonly code: FailureCode, readonly surface?: Surface, readonly subject?: string) {
    super(`e-conomic: ${code}${surface ? ` (${surface})` : ""}`)
    this.name = "EconomicError"
  }
}
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Keep source numbers distinct from JSON strings and preserve their exact decimal lexemes. */
export class ExactNumber {
  constructor(readonly lexeme: string) {}
}
export function parseExactJson(text: string): unknown {
  try {
    return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") return value
      // Node 22+, Bun 1.3 and current V8 expose the source lexeme to the reviver.
      if (!context?.source) throw new EconomicError("invalid_response")
      return new ExactNumber(context.source)
    })
  } catch { throw new EconomicError("invalid_response") }
}

export function safeUrl(surface: Surface, link: string): URL {
  const base = new URL(origins[surface])
  if (link.length > 4096 || /[\\\s]/.test(link) || link.startsWith("//")) throw new EconomicError("unsafe_link", surface)
  let url: URL
  try { url = new URL(link, base) } catch { throw new EconomicError("unsafe_link", surface) }
  const path = url.pathname.slice(base.pathname.length)
  const allowed = surface === "rest"
    ? /^(self|customers|accounting-years|invoices\/booked(?:\/\d+(?:\/pdf)?)?)$/
    : surface === "entries" ? /^booked-entries(?:\/count|\/matched-pairs)?$/
      : /^AttachedDocuments(?:\/count|\/\d+(?:\/pdf)?)?$/
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.hash || !allowed.test(path)) throw new EconomicError("unsafe_link", surface)
  for (const key of url.searchParams.keys()) {
    if (!(surface === "rest" ? ["pagesize", "skippages"] : ["cursor"]).includes(key) || url.searchParams.getAll(key).length !== 1) throw new EconomicError("unsafe_link", surface)
  }
  for (const key of ["pagesize", "skippages"]) {
    const value = url.searchParams.get(key)
    if (value !== null && (!/^\d{1,6}$/.test(value) || (key === "pagesize" && (+value < 1 || +value > 1000)))) throw new EconomicError("unsafe_link", surface)
  }
  return url
}

export type ReadLease = { signal: AbortSignal; assertActive: () => void }
function retryDelay(header: string | null, attempt: number): number {
  if (header && /^\d+$/.test(header)) return Number(header) * 1000
  // HTTP permits both delta-seconds and an HTTP-date. Unknown values use bounded backoff.
  const date = header ? Date.parse(header) : NaN
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 250 * 2 ** attempt
}

export type ReadEvidence = { surface: Surface; path: string; sha256: string; bytes: number; callCost: number | null }
export class EconomicClient {
  readonly evidence: ReadEvidence[] = []
  private bytes = 0
  private calls = 0
  private readonly deadline: number
  constructor(private readonly credentials: Credentials, private readonly runtime: {
    fetch?: typeof fetch
    /** Admit one attempt, including its body read. Every retry needs a fresh generation check. */
    fence?: <T>(read: (lease?: ReadLease) => Promise<T>) => Promise<T>
    timeoutMs?: number
    maxBytes?: number
    maxCalls?: number
  } = {}) { this.deadline = Date.now() + Math.min(runtime.timeoutMs ?? 60_000, 60_000) }

  private async read(surface: Surface, link: string, pdf: boolean) {
    const url = safeUrl(surface, link)
    let requestDeadline: number | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      const run = async (lease?: ReadLease): Promise<{ body: Buffer } | { delay: number }> => {
        requestDeadline ??= Math.min(this.deadline, Date.now() + 10_000)
        const remaining = requestDeadline - Date.now()
        if (remaining <= 0 || ++this.calls > Math.min(this.runtime.maxCalls ?? 500, 500)) throw new EconomicError("limit_exceeded", surface)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.min(remaining, 10_000))
        const signal = lease ? AbortSignal.any([controller.signal, lease.signal]) : controller.signal
        const check = () => { lease?.assertActive(); signal.throwIfAborted() }
        try {
          check()
          const response = await (this.runtime.fetch ?? fetch)(url, {
            method: "GET", redirect: "manual", signal,
            headers: { "X-AppSecretToken": this.credentials.appSecret, "X-AgreementGrantToken": this.credentials.grantToken, Accept: pdf ? "application/pdf" : "application/json" },
          })
          check()
          if (response.status === 429 || response.status === 500) {
            await response.body?.cancel()
            if (attempt === 2) throw new EconomicError("provider_unavailable", surface)
            const delay = retryDelay(response.headers.get("retry-after"), attempt)
            if (delay > 2000 || Date.now() + delay >= requestDeadline) throw new EconomicError("limit_exceeded", surface)
            check()
            return { delay }
          }
          if (response.status !== 200) {
            await response.body?.cancel()
            const code = response.status === 401 ? "revoked" : response.status === 403 ? "missing_role" : response.status === 404 ? "not_found" : response.status >= 300 && response.status < 400 ? "unsafe_link" : response.status < 500 ? "no_access" : "provider_unavailable"
            throw new EconomicError(code, surface)
          }
          const contentType = response.headers.get("content-type")?.split(";")[0]?.trim()
          if (contentType !== (pdf ? "application/pdf" : "application/json")) {
            await response.body?.cancel()
            throw new EconomicError("invalid_response", surface)
          }
          const reader = response.body?.getReader()
          if (!reader) throw new EconomicError("invalid_response", surface)
          const chunks: Uint8Array[] = []
          let size = 0
          try {
            while (true) {
              const result = await reader.read()
              check()
              if (result.done) break
              size += result.value.byteLength
              this.bytes += result.value.byteLength
              if (size > (pdf ? 9_000_000 : 2_000_000) || this.bytes > Math.min(this.runtime.maxBytes ?? 32_000_000, 32_000_000)) throw new EconomicError("limit_exceeded", surface)
              chunks.push(result.value)
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
          check()
          const body = Buffer.concat(chunks)
          if (pdf && body.subarray(0, 5).toString() !== "%PDF-") throw new EconomicError("invalid_response", surface)
          const cost = response.headers.get("x-callcost")
          this.evidence.push({ surface, path: url.pathname, sha256: sha256(body), bytes: size, callCost: cost && /^\d{1,8}$/.test(cost) ? +cost : null })
          return { body }
        } catch (error) {
          lease?.assertActive()
          if (error instanceof EconomicError) throw error
          // Never propagate fetch errors, request objects, provider bodies or credentials.
          throw new EconomicError("provider_unavailable", surface)
        } finally { clearTimeout(timer) }
      }
      const result = this.runtime.fence ? await this.runtime.fence(run) : await run()
      if ("body" in result) return result.body
      // Backoff holds no database lock. Disconnect can finish before the next admission.
      await new Promise(resolve => setTimeout(resolve, result.delay))
    }
    throw new EconomicError("provider_unavailable", surface)
  }
  async json(surface: Surface, link: string) { return parseExactJson((await this.read(surface, link, false)).toString("utf8")) }
  async pdf(surface: Surface, link: string) { return this.read(surface, link, true) }
}
