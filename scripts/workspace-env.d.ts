export type WorkspaceEnvDiscoveryOptions = {
  cwd?: string
  exec?: (
    command: string,
    args: string[],
    options: { cwd: string; encoding: string }
  ) => string
  exists?: (path: string) => boolean
}

export function discoverWorkspaceEnvFile(
  input?: WorkspaceEnvDiscoveryOptions
): string | null

export function discoverWorkspaceEnvDir(
  input?: WorkspaceEnvDiscoveryOptions
): string | null

export function isBorrowedWorkspaceEnvFile(
  envFile: string,
  input?: Omit<WorkspaceEnvDiscoveryOptions, "exists">
): boolean
