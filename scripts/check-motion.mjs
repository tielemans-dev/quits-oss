import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const files = execFileSync("git", ["ls-files", "-z", "apps", "packages"], { cwd: root, encoding: "utf8" }).split("\0")
const forbidden = /\btransition-all\b|\bduration-(?:\d+|\[[\d.]+(?:ms|s)\])|(?<![\w-])ease-(?:linear|in(?:-out)?|out)\b|\bease-\[cubic-bezier/
const failures = []
for (const file of files.filter(f => /\.(?:[jt]sx?|css|html)$/.test(f) && !/motion(?:-tokens\.css|\.ts)$|\.test\./.test(f))) {
  readFileSync(join(root, file), "utf8").split("\n").forEach((line, i) => {
    if (forbidden.test(line)) failures.push(`${file}:${i + 1}: Use shared motion tokens and explicit transition properties`)
  })
}
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1 }
