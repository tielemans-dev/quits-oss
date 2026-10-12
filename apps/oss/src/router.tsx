import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { RuntimeUiProvider, type RuntimeUiExtensions } from './lib/runtime/ui'

export function getRouter(options: { runtimeUi?: RuntimeUiExtensions } = {}) {
  const router = createTanStackRouter({
    routeTree,
    Wrap: ({ children }) => (
      <RuntimeUiProvider value={options.runtimeUi}>{children}</RuntimeUiProvider>
    ),

    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
