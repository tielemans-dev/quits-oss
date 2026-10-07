import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server"
import { bootstrapQuitsRuntime } from "./lib/runtime/bootstrap"
import { selfhostRuntimeServices } from "./selfhost/runtime"

bootstrapQuitsRuntime({ services: selfhostRuntimeServices() })
export default { fetch: createStartHandler(defaultStreamHandler) }
