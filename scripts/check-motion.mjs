import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const files = execFileSync("git", ["ls-files", "-z", "apps", "packages"], { cwd: root, encoding: "utf8" }).split("\0")
const forbidden = new RegExp([
  String.raw`\btransition-all\b`,
  String.raw`\bduration-(?:\d+|\[[\d.]+(?:ms|s)\])`,
  String.raw`(?<![\w-])ease-(?:linear|in(?:-out)?|out)\b`,
  String.raw`\bease-\[cubic-bezier`,
  // Plain CSS: catch-all transitions, and timing literals in the transition/animation shorthands.
  String.raw`\btransition(?:-property)?\s*:\s*all\b`,
  // A zero fallback inside var(--x, 0ms) is not a timing.
  String.raw`(?<![\w-])(?:transition|animation)(?:-duration)?\s*:[^;]*(?<!,\s*)\b\d*\.?\d+m?s\b`,
  // Web Animations: durations come from DURATION, easings from EASE_ENTER/EASE_EXIT.
  String.raw`\bduration:\s*\d`,
  String.raw`\beasing:\s*["'\x60]`,
].join("|"))
const failures = []
for (const file of files.filter(f => /\.(?:[jt]sx?|css|html)$/.test(f) && !/motion(?:-tokens\.css|\.ts)$|\.test\./.test(f))) {
  readFileSync(join(root, file), "utf8").split("\n").forEach((line, i) => {
    if (forbidden.test(line)) failures.push(`${file}:${i + 1}: Use shared motion tokens and explicit transition properties`)
  })
}
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1 }
