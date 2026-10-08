import type { InstallationStatus } from "./installation-state"

/**
 * The root route asks the server whether setup is complete on every navigation. Once it is, that
 * stays true, so the browser keeps the answer for the life of the page. Only a completed setup is
 * kept: while setup is pending the answer changes the moment the wizard finishes, and a kept
 * `false` would send the post-setup navigation back to `/setup`.
 *
 * Browser only. `import.meta.env.SSR` is a build-time constant, so in the server bundle nothing is
 * ever stored in this module-level variable, which every request would share.
 */
let completed: InstallationStatus | null = null

export async function reuseInstallationStatus(
  load: () => Promise<InstallationStatus>
): Promise<InstallationStatus> {
  if (import.meta.env.SSR) return load()
  if (completed) return completed

  const status = await load()
  rememberInstallationStatus(status)
  return status
}

/**
 * Remembers an answer the browser already holds, such as the one the server rendered into the page,
 * so the first client navigation does not ask again. Ignores anything but a completed setup.
 */
export function rememberInstallationStatus(status: InstallationStatus | null | undefined): void {
  if (import.meta.env.SSR || !status?.isSetupComplete) return
  completed = status
}

/** Drops the kept answer. The setup wizard calls it on completion so nothing stale outlives it. */
export function forgetInstallationStatus(): void {
  completed = null
}
