import { useCallback, useSyncExternalStore } from "react"

/**
 * Colour theme preference: `system | light | dark`, kept in localStorage and applied as the `dark`
 * class on <html>.
 *
 * Three pieces keep the class right:
 * - `themeInitScript` runs inline in the document head, before first paint, so there is no flash.
 * - The store below follows `prefers-color-scheme` while the preference is `system`, and other
 *   tabs through the `storage` event.
 * - `ThemeProvider` re-applies it when the route changes, since public document pages are always
 *   light.
 */

export const THEME_STORAGE_KEY = "quits-theme"

export const themePreferences = ["system", "light", "dark"] as const
export type ThemePreference = (typeof themePreferences)[number]
export type ResolvedTheme = "light" | "dark"

const DARK_QUERY = "(prefers-color-scheme: dark)"

/**
 * The browser chrome colour per theme: the hex of `--background` in `:root` and in `.dark` (see
 * styles.css). One `<meta name="theme-color">` carries it, so it follows the resolved theme rather
 * than the OS setting.
 */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#fcfcf9",
  dark: "#0d1013",
}

/**
 * Public document pages show a supplier's document to their customer, not our interface:
 * `/pay/:token` (invoice payment), `/q/:token` (quote) and `/a/:token` (agreement). They always
 * render light.
 */
const PUBLIC_DOCUMENT_PATH = /^\/(pay|q|a)(\/|$)/

export function isPublicDocumentPath(pathname: string): boolean {
  return PUBLIC_DOCUMENT_PATH.test(pathname)
}

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system"
}

export function resolveTheme(input: {
  preference: ThemePreference
  systemPrefersDark: boolean
  pathname: string
}): ResolvedTheme {
  if (isPublicDocumentPath(input.pathname)) return "light"
  if (input.preference === "system") return input.systemPrefersDark ? "dark" : "light"
  return input.preference
}

/**
 * Runs inline in the document head before first paint. It repeats `resolveTheme` in ES5 because it
 * cannot import anything; a unit test runs it against the same inputs. It also sets the
 * `theme-color` meta to the resolved theme's colour.
 */
export const themeInitScript = `(function(){var s=null;try{s=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)})}catch(e){}var d=!${PUBLIC_DOCUMENT_PATH.toString()}.test(location.pathname)&&(s==="dark"||(s!=="light"&&typeof matchMedia==="function"&&matchMedia(${JSON.stringify(
  DARK_QUERY
)}).matches));document.documentElement.classList.toggle("dark",d);var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement("meta");m.name="theme-color";document.head.appendChild(m)}m.content=d?${JSON.stringify(
  THEME_COLORS.dark
)}:${JSON.stringify(THEME_COLORS.light)}})()`

function readStoredPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return "system"
  }
}

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null
}

function systemPrefersDark(): boolean {
  return darkQuery()?.matches ?? false
}

/** Sets the single `theme-color` meta, creating it when the document has none. */
function setThemeColor(theme: ResolvedTheme) {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement("meta")
    meta.name = "theme-color"
    document.head.appendChild(meta)
  }
  meta.content = THEME_COLORS[theme]
}

/** Puts the `dark` class and the `theme-color` meta on the document to match the preference, for the page at `pathname`. */
export function applyTheme(
  pathname: string = window.location.pathname,
  preference: ThemePreference = getPreference()
): ResolvedTheme {
  const theme = resolveTheme({
    preference,
    systemPrefersDark: systemPrefersDark(),
    pathname,
  })
  document.documentElement.classList.toggle("dark", theme === "dark")
  setThemeColor(theme)
  return theme
}

let preference: ThemePreference | null = null
const listeners = new Set<() => void>()

function getPreference(): ThemePreference {
  preference ??= readStoredPreference()
  return preference
}

function notify() {
  applyTheme()
  for (const listener of listeners) listener()
}

function onStorage(event: StorageEvent) {
  // `key` is null when the whole storage was cleared.
  if (event.key !== null && event.key !== THEME_STORAGE_KEY) return
  preference = readStoredPreference()
  notify()
}

function onSystemChange() {
  // Only matters while the preference is `system`, but applying is idempotent.
  notify()
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage)
    darkQuery()?.addEventListener("change", onSystemChange)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage)
      darkQuery()?.removeEventListener("change", onSystemChange)
    }
  }
}

function setPreference(next: ThemePreference) {
  preference = next
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // Storage may be unavailable (private mode); the preference still holds for this page.
  }
  notify()
}

/** Resets module state between tests. */
export function resetThemeForTesting() {
  preference = null
  listeners.clear()
}

const SERVER_PREFERENCE: ThemePreference = "system"

export function useTheme() {
  const current = useSyncExternalStore(subscribe, getPreference, () => SERVER_PREFERENCE)
  const set = useCallback((next: ThemePreference) => setPreference(next), [])
  return { preference: current, setPreference: set }
}
