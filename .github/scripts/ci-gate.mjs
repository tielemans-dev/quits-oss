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
const runBrowser = paths?.outputs?.["run-browser"]
if (runBrowser !== undefined && !["true", "false"].includes(runBrowser)) {
  throw new Error("Browser classification returned an invalid result")
}
if (runBrowser === "false" && process.env.EVENT_NAME !== "pull_request") {
  throw new Error("Only a documentation or GitHub metadata PR may skip browsers")
}
const workers = Object.entries(needs).filter(([name]) => name !== "paths")
if (workers.length === 0) throw new Error("No verification jobs were supplied")
for (const [name, job] of workers) {
  const skipBrowser = name === "shared-browser-worker" && runBrowser === "false"
  const expected = docsOnly || skipBrowser ? "skipped" : "success"
  if (job.result !== expected) {
    throw new Error(`${name}: expected ${expected}, received ${job.result}`)
  }
}
console.log(docsOnly ? "Confirmed documentation-only PR; verification intentionally omitted" : "All verification jobs succeeded")
