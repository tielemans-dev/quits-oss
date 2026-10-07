import { createJsonLogger } from "@quits/shared/logging"
import { readBooleanEnv, readProductEnv } from "@quits/shared/runtimeEnv"

const isTestEnv =
  process.env.VITEST === "true" || process.env.NODE_ENV?.trim().toLowerCase() === "test"
const structuredLogsEnabled = readBooleanEnv(readProductEnv(process.env, "JSON_LOGS"), !isTestEnv)

export const appLogger = createJsonLogger({
  service: "@quits/oss",
  sink(line) {
    if (!structuredLogsEnabled) {
      return
    }

    process.stdout.write(`${line}\n`)
  },
})
