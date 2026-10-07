import { expect } from "vitest"
import { postingsFor, postingRoles, type PostingEvent, type Posting, type PostingRole, type PostingRefusalCode } from "../postings"
export const balances = (values: Partial<Record<PostingRole, string>> = {}): Record<PostingRole, string> => Object.fromEntries(postingRoles.map(role => [role, values[role] ?? "0"])) as Record<PostingRole, string>
/** Positive balances are debits; negative balances are credits. This ledger is test-only. */
export class TestLedger {
  private entries: Posting[] = []
  apply(event: PostingEvent) {
    const lines = postingsFor(event)
    expect(Array.isArray(lines), JSON.stringify(lines)).toBe(true)
    if (!Array.isArray(lines)) throw new Error(lines.code)
    expect(lines.reduce((sum, l) => sum + BigInt(l.debitMinor), 0n)).toBe(lines.reduce((sum, l) => sum + BigInt(l.creditMinor), 0n))
    this.entries.push(...lines)
    return lines
  }
  refuse(event: PostingEvent, code: PostingRefusalCode) {
    expect(postingsFor(event)).toMatchObject({ code })
  }
  assertEnding(roles: Partial<Record<PostingRole, string>>, groups: Record<string, Partial<Record<PostingRole, string>>>) {
    const ending = (entries: Posting[]) => balances(Object.fromEntries(postingRoles.map(role => [role, entries.filter(e => e.role === role).reduce((sum, e) => sum + BigInt(e.debitMinor) - BigInt(e.creditMinor), 0n).toString()])))
    expect(ending(this.entries)).toEqual(balances(roles))
    const actualGroups = [...new Set(this.entries.flatMap(e => e.vatGroup === null ? [] : [e.vatGroup]))].sort()
    expect(actualGroups).toEqual(Object.keys(groups).sort())
    for (const [key, expected] of Object.entries(groups)) expect(ending(this.entries.filter(e => e.vatGroup === key))).toEqual(balances(expected))
    expect(this.entries.reduce((sum, e) => sum + BigInt(e.debitMinor) - BigInt(e.creditMinor), 0n)).toBe(0n)
  }
}
