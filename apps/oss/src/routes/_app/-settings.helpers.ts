export type AiProviderId = "openrouter" | "openai_compatible" | "cli_agent"

export function shouldAutoLoadAiModels(
  input: {
    provider: AiProviderId
    baseUrl: string | null | undefined
    currentModel: string | null | undefined
  },
  fallbackModels: string[]
) {
  if (input.provider === "cli_agent") {
    return false
  }

  if (input.provider === "openai_compatible" && !input.baseUrl?.trim()) {
    return false
  }

  const normalizedModel = input.currentModel?.trim()
  if (!normalizedModel) {
    return false
  }

  return !fallbackModels.includes(normalizedModel)
}
