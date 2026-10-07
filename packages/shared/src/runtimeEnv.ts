export function readBooleanEnv(
  value: string | undefined,
  defaultValue: boolean
) {
  if (value === undefined) {
    return defaultValue
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === "true") {
    return true
  }
  if (normalized === "false") {
    return false
  }

  return defaultValue
}

export function resolveUrlOrigin(value: string | undefined) {
  if (!value?.trim()) {
    return null
  }

  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function readFallbackSecret(
  primary: string | undefined,
  fallback: string | undefined,
  minimumLength = 16
) {
  const normalizedPrimary = primary?.trim()
  if (normalizedPrimary && normalizedPrimary.length >= minimumLength) {
    return normalizedPrimary
  }

  const normalizedFallback = fallback?.trim()
  if (normalizedFallback && normalizedFallback.length >= minimumLength) {
    return normalizedFallback
  }

  return null
}

/**
 * Reads a product setting, `QUITS_<name>`, falling back to `YAIP_<name>` from before the product
 * was renamed, so existing deployments keep working without changing their environment.
 */
export function readProductEnv(env: Record<string, string | undefined>, name: string) {
  return env[`QUITS_${name}`] ?? env[`YAIP_${name}`]
}
