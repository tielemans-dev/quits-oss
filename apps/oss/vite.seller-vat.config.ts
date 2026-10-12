import { mergeConfig } from "vite"
import config from "./vite.config"

// Only the disposable hosted CI job imports a synthetic public runtime extension.
export default mergeConfig(config, { plugins: [{
  name: "qui62-hosted-contract-fixture",
  enforce: "pre",
  transform(code, id) {
    if (process.env.QUI62_HOSTED_FIXTURE === "true" && id.replaceAll("\\", "/").endsWith("/src/server.ts")) {
      return `${code}\nimport { installHostedVatFixture } from "../tests/e2e/hosted-vat-extension";\ninstallHostedVatFixture();\n`
    }
  },
}] })
