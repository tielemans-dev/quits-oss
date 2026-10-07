import { executeIssuanceCommand } from "../../application/issuance"
import { setIssuanceDispatcher } from "../../domain/issuance-dispatcher"
import {
  setRuntimeExtensions,
  type RuntimeExtension,
} from "./extensions"
import {
  resetRuntimeServices,
  setRuntimeServices,
  type RuntimeServices,
} from "./services"
import {
  resetRuntimePlatform,
  setRuntimePlatform,
  type RuntimePlatform,
} from "./platform"

export function bootstrapQuitsRuntime(input: {
  platform?: RuntimePlatform
  extensions?: RuntimeExtension[]
  services?: Partial<RuntimeServices>
}) {
  setIssuanceDispatcher(executeIssuanceCommand)
  if (input.platform) {
    setRuntimePlatform(input.platform)
  }

  if (input.extensions) {
    setRuntimeExtensions(input.extensions)
  }

  if (input.services) {
    setRuntimeServices(input.services)
  }
}

export function resetQuitsRuntimeForTests() {
  resetRuntimePlatform()
  setRuntimeExtensions([])
  resetRuntimeServices()
}

/** @deprecated Renamed to `bootstrapQuitsRuntime`. */
export const bootstrapYaipRuntime = bootstrapQuitsRuntime
/** @deprecated Renamed to `resetQuitsRuntimeForTests`. */
export const resetYaipRuntimeForTests = resetQuitsRuntimeForTests
