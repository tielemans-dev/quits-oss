// Required checks must execute, even when PR-only classification skips work.
const needs = JSON.parse(process.env.NEEDS_JSON ?? "{}")
const paths = needs.paths
const run = paths?.outputs?.["run-expensive"]
if (paths?.result !== "success" || !["true", "false"].includes(run)) {
  throw new Error("Path classification failed or returned an invalid result")
}
const docsOnly = process.env.EVENT_NAME === "pull_request" && run === "false"
if (run === "false" && !docsOnly) {
  throw new Error("Only a documentation-only PR may skip verification")
}
const workers = Object.entries(needs).filter(([name]) => name !== "paths")
if (workers.length === 0) throw new Error("No verification jobs were supplied")
for (const [name, job] of workers) {
  const expected = docsOnly ? "skipped" : "success"
  if (job.result !== expected) {
    throw new Error(`${name}: expected ${expected}, received ${job.result}`)
  }
}
console.log(docsOnly ? "Confirmed documentation-only PR; verification intentionally omitted" : "All verification jobs succeeded")
