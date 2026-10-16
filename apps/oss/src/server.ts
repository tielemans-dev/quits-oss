import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server"
import { bootstrapQuitsRuntime } from "./lib/runtime/bootstrap"
import { selfhostRuntimeServices } from "./selfhost/runtime"
import { startDevScheduler } from "./selfhost/dev-scheduler"

bootstrapQuitsRuntime({ services: selfhostRuntimeServices() })
if (import.meta.env.DEV) {
  const stop = startDevScheduler()
  import.meta.hot?.dispose(stop)
}
export default { fetch: createStartHandler(defaultStreamHandler) }
