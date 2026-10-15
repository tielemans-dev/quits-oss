import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const gate = new URL("ci-gate.mjs", import.meta.url)
const workers = ["lint", "typecheck", "unit", "runtime", "shared-browser-worker"]
function accepts(event, run, results, classification = "success", browser) {
  const needs = {
    paths: { result: classification, outputs: { "run-expensive": run, "run-browser": browser } },
    ...Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { result }])),
  }
  return spawnSync(process.execPath, [gate.pathname], {
    env: { ...process.env, EVENT_NAME: event, NEEDS_JSON: JSON.stringify(needs) },
  }).status === 0
}
const results = (status) => Object.fromEntries(workers.map((name) => [name, status]))

test("PR code, main push, tag push and merge group require all jobs to succeed", () => {
  for (const event of ["pull_request", "push", "merge_group"]) {
    assert.equal(accepts(event, "true", results("success")), true)
    for (const worker of workers) {
      for (const status of ["failure", "cancelled", "skipped", "unknown"]) {
        assert.equal(accepts(event, "true", { ...results("success"), [worker]: status }), false)
      }
    }
  }
})
test("only confirmed docs-only PRs accept intentionally skipped workers", () => {
  assert.equal(accepts("pull_request", "false", results("skipped")), true)
  for (const event of ["push", "merge_group", "workflow_dispatch", "release"]) {
    assert.equal(accepts(event, "false", results("skipped")), false)
  }
  for (const worker of workers) {
    for (const status of ["failure", "cancelled", "success"]) {
      assert.equal(accepts("pull_request", "false", { ...results("skipped"), [worker]: status }), false)
    }
  }
})
test("classification errors and missing work fail closed", () => {
  for (const status of ["failure", "cancelled", "skipped"]) {
    assert.equal(accepts("pull_request", "false", results("skipped"), status), false)
  }
  for (const run of [undefined, "", "unknown"]) {
    assert.equal(accepts("pull_request", run, results("success")), false)
  }
  assert.equal(accepts("pull_request", "true", {}), false)
  for (const worker of ["shared-browser-worker", "boundary-worker"]) {
    assert.equal(accepts("pull_request", "false", { [worker]: "skipped" }), true)
    assert.equal(accepts("push", "true", { [worker]: "failure" }), false)
  }
})

test("documentation and GitHub metadata PRs skip browsers while other jobs must succeed", () => {
  const mixed = { ...results("success"), "shared-browser-worker": "skipped" }
  assert.equal(accepts("pull_request", "true", mixed, "success", "false"), true)
  for (const event of ["push", "merge_group"]) {
    assert.equal(accepts(event, "true", mixed, "success", "false"), false)
  }
  for (const worker of workers) {
    assert.equal(accepts("pull_request", "true", { ...mixed, [worker]: "failure" }, "success", "false"), false)
  }
  assert.equal(accepts("pull_request", "true", mixed, "success", "unknown"), false)
})
