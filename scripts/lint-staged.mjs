import { spawnSync } from "node:child_process"
import { lstatSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

export function lintStaged(root = repositoryRoot) {
  const git = (args) => {
    const result = spawnSync("git", ["--literal-pathspecs", ...args], {
      cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    })
    if (result.error) throw result.error
    return result
  }

  const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
  if (staged.status !== 0) throw new Error("Could not list staged files")
  // Avoid shell interpolation and line splitting, including for multiline filenames.
  const files = staged.stdout.split("\0").filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file))
  if (files.length === 0) return 0

  for (const file of files) {
    const name = JSON.stringify(file)
    const unstaged = git(["diff", "--quiet", "--", file])
    if (unstaged.status === 1) {
      throw new Error(`Stage all changes to ${name}, or unstage it, before committing. Partial staging is not supported by this hook.`)
    }
    if (unstaged.status !== 0) throw new Error(`Could not check unstaged changes to ${name}`)
    // Never pass a directory or symlink to Oxlint, which could traverse other files.
    if (!lstatSync(resolve(root, file)).isFile()) {
      throw new Error(`Staged source ${name} must be a regular file`)
    }
  }

  // Use only the installed binary. No bunx fetch, recursive lint script, fix, or staging.
  const oxlint = resolve(root, "node_modules/.bin/oxlint")
  for (let offset = 0; offset < files.length; offset += 50) {
    const result = spawnSync(oxlint, [
      "--deny-warnings", "--report-unused-disable-directives", "--",
      ...files.slice(offset, offset + 50).map((file) => `./${file}`),
    ], { cwd: root, stdio: "inherit" })
    if (result.error) throw new Error("Local Oxlint could not start. Run bun install first.", { cause: result.error })
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = lintStaged()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
