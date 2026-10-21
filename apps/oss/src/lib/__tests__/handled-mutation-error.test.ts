import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const src = fileURLToPath(new URL("../..", import.meta.url))
/** Screens still showing a caught failure twice (QUI-227). Remove a file once its mutations opt out. */
const notYetSwept = [
  "components/agents/approval-item.tsx", "components/agents/create-agent-key-dialog.tsx", "components/agreements/template-manager.tsx",
  ...["credit-note-request", "customer-request", "payment-match", "vat-request"].map(card => `components/command-bar/${card}-card.tsx`),
  "components/recurring/recurring-schedule-dialog.tsx", "components/setup/setup-wizard.tsx", "components/shell/palette/bank-provider.tsx",
  "routes/_app/agreements/$agreementId.tsx", "routes/_app/billing.tsx", "routes/_app/catalog.tsx",
]

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? (entry.name === "__tests__" ? [] : sources(join(dir, entry.name)))
    : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
const rootName = (node: ts.Expression): string | undefined =>
  ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? rootName(node.expression) : undefined

/** A local error presentation: `setError(...)`, `setMessage(...)`, `onError(...)` or `target.sendError = ...`. */
function presentsError(node: ts.Node): boolean {
  const callee = ts.isCallExpression(node) ? (ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression) : undefined
  if (callee && ts.isIdentifier(callee) && /^(set|on)\w*(Error|Message)s?$/.test(callee.text)) return true
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) && node.left.name.text.endsWith("Error")) return true
  return ts.forEachChild(node, presentsError) ?? false
}

/** What catches the call's failure in the same function: a `catch` block, or a promise `.catch`/`.then` rejection handler. */
function failureHandler(call: ts.Node): ts.Node | undefined {
  for (let child = call, parent = call.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
    if (ts.isTryStatement(parent) && parent.tryBlock === child && parent.catchClause) return parent.catchClause.block
    if (ts.isPropertyAccessExpression(parent) && parent.expression === child && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
      if (parent.name.text === "catch") return parent.parent.arguments[0]
      if (parent.name.text === "then" && parent.parent.arguments[1]) return parent.parent.arguments[1]
    }
  }
}

/** Lines of `trpc` mutations whose caller shows the failure itself yet leaves the global `MutationErrors` banner on. */
function doublyReported(fileName: string, text: string): number[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lines: number[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "mutate" &&
      rootName(node.expression.expression) === "trpc" && node.arguments.length < 2) {
      const handler = failureHandler(node)
      if (handler && presentsError(handler)) lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}

describe("mutations with their own error presentation", () => {
  it("are recognised when caught inline and not once opted out", () => {
    const inline = `async function save() { try { await trpc.agreements.updateDraftDecimal.mutate(input) } catch (err) { setError(String(err)) } }`
    expect(doublyReported("inline.ts", inline)).toEqual([1])
    expect(doublyReported("chained.ts", `trpc.creditNotes.discardDraft.mutate({ id }).then(close).catch(() => { setError(true) })`)).toEqual([1])
    expect(doublyReported("handled.ts", inline.replace("mutate(input)", "mutate(input, handledMutationError)"))).toEqual([])
    expect(doublyReported("swallowed.ts", `try { await trpc.invoices.delete.mutate({ id }) } catch { /* the banner says it */ }`)).toEqual([])
  })

  it("opt out of the global MutationErrors banner with handledMutationError", () => {
    const offenders = sources(src).flatMap(path => doublyReported(path, readFileSync(path, "utf8")).map(line => `${relative(src, path)}:${line}`))
    expect(offenders.filter(site => !notYetSwept.some(name => site.startsWith(`${name}:`)))).toEqual([])
    // A swept screen leaves the list, so the list only shrinks.
    expect(notYetSwept.filter(name => !offenders.some(site => site.startsWith(`${name}:`)))).toEqual([])
  })
})
