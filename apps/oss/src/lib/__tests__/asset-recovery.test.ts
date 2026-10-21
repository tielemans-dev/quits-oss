// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { assetRecoveryScript, assetRecoverySource } from "../asset-recovery"

const ORIGIN = "https://app.example.test"

/** A window with real events and storage, whose reloads are counted instead of performed. */
function fakeWindow(storage: Storage = window.sessionStorage) {
  const target = new EventTarget()
  const reload = vi.fn()
  const win = Object.assign(target, {
    location: { href: `${ORIGIN}/invoices/inv_1`, origin: ORIGIN, reload },
    sessionStorage: storage,
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
  })
  new Function("win", `(${assetRecoverySource})(win)`)(win)
  return { win: target, reload }
}

function failedLoad(win: EventTarget, attributes: { src?: string; href?: string }) {
  const event = new Event("error")
  Object.defineProperty(event, "target", { value: attributes })
  win.dispatchEvent(event)
}

function rejectedImport(win: EventTarget, message: string) {
  const event = new Event("unhandledrejection")
  Object.defineProperty(event, "reason", { value: new TypeError(message) })
  win.dispatchEvent(event)
}

/** A page load after a reload: a fresh window sharing the same tab's storage. */
function nextPageLoad() {
  return fakeWindow()
}

beforeEach(() => {
  vi.useFakeTimers()
  window.sessionStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("asset recovery", () => {
  it("reloads shortly after a built file fails to load", () => {
    const { win, reload } = fakeWindow()
    failedLoad(win, { href: `${ORIGIN}/assets/_invoiceId-DDJYPh7D.js` })
    vi.advanceTimersByTime(999)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("reloads when the entry import fails, in each browser's wording", () => {
    for (const message of [
      `Failed to fetch dynamically imported module: ${ORIGIN}/assets/main-O3ov44AI.js`,
      `error loading dynamically imported module: ${ORIGIN}/assets/main-O3ov44AI.js`,
      "Importing a module script failed.",
    ]) {
      window.sessionStorage.clear()
      const { win, reload } = fakeWindow()
      rejectedImport(win, message)
      vi.advanceTimersByTime(1000)
      expect(reload, message).toHaveBeenCalledTimes(1)
    }
  })

  it("ignores failures that are not the app's built files", () => {
    const { win, reload } = fakeWindow()
    failedLoad(win, { src: `${ORIGIN}/api/documents/invoice/inv_1/logo` })
    failedLoad(win, { src: "https://cdn.example.test/assets/widget.js" })
    failedLoad(win, { href: `${ORIGIN}/favicon.svg` })
    rejectedImport(win, "Failed to fetch dynamically imported module: https://cdn.example.test/assets/x.js")
    rejectedImport(win, "Network request failed")
    vi.advanceTimersByTime(60_000)
    expect(reload).not.toHaveBeenCalled()
  })

  it("schedules one reload however many files fail on the page", () => {
    const { win, reload } = fakeWindow()
    for (let i = 0; i < 20; i++) failedLoad(win, { src: `/assets/chunk-${i}.js` })
    vi.advanceTimersByTime(60_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("backs off over a few reloads, then stops", () => {
    const delays: number[] = []
    for (let attempt = 0; attempt < 6; attempt++) {
      const { win, reload } = nextPageLoad()
      failedLoad(win, { src: "/assets/main-O3ov44AI.js" })
      let waited = 0
      while (!reload.mock.calls.length && waited < 30_000) {
        vi.advanceTimersByTime(500)
        waited += 500
      }
      delays.push(reload.mock.calls.length ? waited : -1)
    }
    expect(delays).toEqual([1000, 2000, 5000, 10000, -1, -1])
  })

  it("tries again after the attempts have aged out", () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { win } = nextPageLoad()
      failedLoad(win, { src: "/assets/main-O3ov44AI.js" })
      vi.advanceTimersByTime(10_000)
    }
    vi.advanceTimersByTime(121_000)
    const { win, reload } = nextPageLoad()
    failedLoad(win, { src: "/assets/main-CPd3SUEe.js" })
    vi.advanceTimersByTime(1000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("does not reload when it cannot count its attempts", () => {
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled")
      },
    } as unknown as Storage
    const { win, reload } = fakeWindow(blocked)
    failedLoad(win, { src: "/assets/main-O3ov44AI.js" })
    vi.advanceTimersByTime(60_000)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe("assetRecoveryScript", () => {
  it("runs inline on its own", () => {
    expect(() => new Function(assetRecoveryScript)()).not.toThrow()
  })
})
