// Imported for its side effect: registers the concrete AI provider factories with lib/ai/provider.
import { registerAiProviderFactories } from "../provider"
import { createCliAgentProvider } from "./cli-agent"
import { createOpenAiCompatibleProvider } from "./openai-compatible"

registerAiProviderFactories({
  openaiCompatible: createOpenAiCompatibleProvider,
  cliAgent: createCliAgentProvider,
})
