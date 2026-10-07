export function isSetupGuardBypassPath(pathname: string) {
  return (
    pathname === "/setup" ||
    pathname.startsWith("/setup/") ||
    pathname === "/login" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    pathname === "/signup" ||
    pathname === "/accept-invitation" ||
    pathname.startsWith("/accept-invitation/") ||
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname === "/healthz"
  )
}

export function shouldRedirectToSetup(
  pathname: string,
  isSetupComplete: boolean,
  distribution: string = "selfhost"
) {
  if (distribution === "cloud") {
    return false
  }

  if (isSetupComplete) {
    return false
  }
  return !isSetupGuardBypassPath(pathname)
}
