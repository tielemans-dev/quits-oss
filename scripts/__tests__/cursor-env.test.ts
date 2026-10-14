import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const script = join(root, "scripts/dev-db-start.sh");
const URL_5432 = "postgresql://postgres:postgres@localhost:5432/yaip";

function stub(dir: string, name: string, body: string) {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function run(opts: { pgReady?: 0 | 1; docker?: boolean; url?: string }) {
  const bin = mkdtempSync(join(tmpdir(), "dbstart-"));
  const log = join(bin, "docker.log");
  if (opts.pgReady !== undefined)
    stub(bin, "pg_isready", `exit ${opts.pgReady === 0 ? 0 : 2}`);
  // Always shadow the host's real docker so tests never touch it.
  stub(
    bin,
    "docker",
    opts.docker
      ? `echo "$*" >> "${log}"\nexit 0`
      : `echo "$*" >> "${log}"\n[[ "$1" == "info" ]] && exit 1\nexit 0`,
  );
  const result = spawnSync("/bin/bash", [script], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      DATABASE_URL: opts.url ?? URL_5432,
      HOME: bin,
    },
    encoding: "utf8",
  });
  let dockerCalls = "";
  try {
    dockerCalls = readFileSync(log, "utf8");
  } catch {}
  return { ...result, dockerCalls, output: `${result.stdout}${result.stderr}` };
}

describe("dev-db-start.sh", () => {
  it("reuses a native Postgres without touching Docker", () => {
    const r = run({ pgReady: 0, docker: true });
    expect(r.status).toBe(0);
    expect(r.output).toContain("reusing it");
    expect(r.dockerCalls).toBe("");
  });

  it("falls back to Docker when nothing is listening", () => {
    const r = run({ pgReady: 1, docker: true });
    expect(r.status).toBe(0);
    expect(r.dockerCalls).toContain("run -d");
  });

  it("fails visibly when nothing listens and Docker is missing", () => {
    const r = run({ pgReady: 1, docker: false });
    expect(r.status).toBe(1);
    expect(r.output).toContain("Docker is not available");
    expect(r.dockerCalls).not.toContain("run");
  });

  it("keeps rejecting non-local hosts", () => {
    const r = run({ pgReady: 0, url: "postgresql://u:p@db.internal:5432/x" });
    expect(r.status).toBe(1);
    expect(r.output).toContain("only manages local Docker Postgres");
  });

  it("honours an explicit port from DATABASE_URL", () => {
    const r = run({
      pgReady: 1,
      docker: true,
      url: "postgresql://u:p@localhost:6543/x",
    });
    expect(r.dockerCalls).toContain("-p 6543:5432");
  });
});

describe("cursor image", () => {
  const dockerfile = readFileSync(join(root, ".cursor/Dockerfile"), "utf8");

  it("installs ripgrep and creates the default database", () => {
    expect(dockerfile).toMatch(/\bripgrep\b/);
    expect(dockerfile).toContain("createdb yaip");
    expect(dockerfile).toContain(`ENV DATABASE_URL=${URL_5432}`);
  });

  it("pins Playwright Chromium to the locked version", () => {
    const lock = readFileSync(join(root, "bun.lock"), "utf8");
    const locked = /"playwright": \["playwright@([\d.]+)"/.exec(lock)?.[1];
    const pinned = /ARG PLAYWRIGHT_VERSION=([\d.]+)/.exec(dockerfile)?.[1];
    expect(pinned).toBe(locked);
    expect(dockerfile).toContain("install --with-deps chromium");
    expect(dockerfile).toContain("PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright");
  });
});
