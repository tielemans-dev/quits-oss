/**
 * How well the decision model reads palette sentences, against the real API. Not run in CI: it
 * costs a call per sentence (about 150 tokens each). Run when changing the question or the
 * thresholds in `decision-provider.tsx`, or to see whether `jev-latest` has changed underneath:
 *
 *   QUITS_TYPESAFE_API_KEY=… bun scripts/eval-request-decisions.ts
 */
import { decideRequest } from "../src/lib/ai/decide-request"

const SENTENCES: Array<[text: string, kind: string]> = [
  ["hvem skylder mig penge", "overdue"],
  ["hvilke fakturaer er ikke betalt", "overdue"],
  ["send rykkere til dem der ikke har betalt", "overdue"],
  ["er der nogen der er bagud med betalingen", "overdue"],
  ["havblik skal have en faktura på 5 timer", "invoice"],
  ["send birk en regning på 5000 kr", "invoice"],
  ["lav en faktura til studio vester", "invoice"],
  ["jeg skal fakturere havblik for logoet", "invoice"],
  ["annuller fakturaen til birk", "creditNote"],
  ["birk skal have pengene tilbage", "creditNote"],
  ["lav en kreditnota til havblik", "creditNote"],
  ["fakturaen til studio vester var forkert", "creditNote"],
  ["birk har betalt", "payment"],
  ["havblik har overført 4.000 kr", "payment"],
  ["pengene fra studio vester er kommet", "payment"],
  ["opret en ny kunde", "customer"],
  ["tilføj kunden med cvr 12345678", "customer"],
  ["hvad skal jeg betale i moms", "vat"],
  ["hvor meget moms skylder jeg", "vat"],
  ["momsen for dette kvartal", "vat"],
  ["vis mine kunder", "search"],
  ["gå til indstillinger", "search"],
  ["alle fakturaer fra marts", "search"],
  ["skift sprog til engelsk", "search"],
  ["who owes me money", "overdue"],
  ["invoice havblik for 3 hours", "invoice"],
]

const apiKey = (process.env.QUITS_TYPESAFE_API_KEY ?? process.env.YAIP_TYPESAFE_API_KEY)?.trim()
if (!apiKey) throw new Error("Set QUITS_TYPESAFE_API_KEY")

let right = 0
for (const [text, expected] of SENTENCES) {
  const started = performance.now()
  const decision = await decideRequest({ apiKey, text })
  const ms = Math.round(performance.now() - started)
  const ok = decision?.kind === expected
  if (ok) right++
  console.log(`${ok ? "ok  " : "MISS"} ${String(decision?.probability.toFixed(2) ?? "–").padEnd(5)} ${String(decision?.kind ?? "error").padEnd(10)} ${String(ms).padStart(4)}ms  ${text}${ok ? "" : `  (want ${expected})`}`)
}
console.log(`\n${right}/${SENTENCES.length} right`)
