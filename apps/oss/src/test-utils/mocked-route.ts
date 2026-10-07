import type { ComponentType } from "react"

/**
 * Route tests mock `createFileRoute`/`createRootRoute` to return the options object,
 * so the imported `Route` is that options object at runtime.
 */
export type MockedRouteOptions = {
  component: ComponentType
  beforeLoad: (context: unknown) => Promise<unknown>
}

export function asMockedRoute(route: unknown): MockedRouteOptions {
  return route as MockedRouteOptions
}
