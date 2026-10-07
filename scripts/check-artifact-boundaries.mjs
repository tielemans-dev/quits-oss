import { readFileSync, readdirSync, existsSync } from "node:fs"
import { resolve, dirname, relative } from "node:path"
import ts from "typescript"

const source = resolve(process.argv[2] ?? new URL("../apps/oss/src", import.meta.url).pathname)
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : files(path)
    return /\.[cm]?tsx?$/.test(entry.name) ? [path] : []
  })
}
function imports(file) {
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const values = []
  function visit(node) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      // Imports containing only explicitly type-only specifiers are erased too.
      const named = node.importClause?.namedBindings
      if (!(named && ts.isNamedImports(named) && named.elements.length && named.elements.every(x => x.isTypeOnly) && !node.importClause?.name)) values.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) values.push(node.moduleSpecifier.text)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) values.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return values
}
function local(file, name) {
  const base = name.startsWith(".") ? resolve(dirname(file), name) : name.startsWith("#/") || name.startsWith("@/") ? resolve(source, name.slice(2)) : null
  if (!base) return null
  return [base, ...[".ts", ".tsx", ".js", "/index.ts"].map(suffix => base + suffix)].find(existsSync) ?? null
}
const graph = new Map(files(source).map(file => [file, imports(file)]))
for (const [file, names] of graph) {
  const path = relative(source, file)
  for (const name of names) {
    const target = local(file, name)
    if (target && relative(source, target).startsWith("selfhost/") && path !== "server.ts") throw new Error(`${path} imports selfhost: ${name}`)
    if (!path.startsWith("selfhost/") && /^(node:)?fs(?:\/|$)/.test(name)) throw new Error(`${path} imports filesystem APIs`)
  }
  if (!path.startsWith("selfhost/") && /\bBun\.|\brenderToBuffer\s*\(|\.toBlob\s*\(/.test(readFileSync(file, "utf8"))) throw new Error(`${path} uses host rendering APIs`)
}
const visited = new Set(), active = new Set()
function walk(file) {
  if (relative(source, file).startsWith("selfhost/") || file === resolve(source, "server.ts")) throw new Error(`Published import graph reaches selfhost: ${file}`)
  if (active.has(file)) {
    // Existing UI cycles are outside this check; issuance must never participate in one.
    if ([...active].some(path => relative(source, path) === "application/issuance.ts")) throw new Error(`Issuance import cycle through ${file}`)
    return
  }
  if (visited.has(file)) return
  visited.add(file); active.add(file)
  for (const name of graph.get(file) ?? []) { const target = local(file, name); if (target) walk(target) }
  active.delete(file)
}
for (const entry of ["router.tsx", "lib/runtime/bootstrap.ts", "application/issuance.ts"]) walk(resolve(source, entry))
console.log(`Artifact boundaries passed: ${graph.size} core modules, ${visited.size} published graph modules; no issuance import cycle`)
