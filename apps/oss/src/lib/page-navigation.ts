/**
 * Full page loads. Changing which organization a tab acts for (switching organization, signing in
 * or out) always loads a new page, so the app layout initializes it once, from the session, and
 * nothing of the previous organization's pages survives. Kept in its own module so tests can
 * replace it (jsdom cannot navigate).
 */

/** Loads `path` as a new page. */
export function loadPage(path: string): void {
  window.location.assign(path)
}

/** Reloads the current page. */
export function reloadPage(): void {
  window.location.reload()
}
