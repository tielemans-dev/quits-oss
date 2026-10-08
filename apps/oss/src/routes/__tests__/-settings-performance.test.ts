import { describe, expect, it } from "vitest"

import { shouldAutoLoadAiModels } from "../_app/-settings.helpers"

const FALLBACK = ["openai/gpt-4o-mini", "openai/gpt-4.1-mini"]

describe("settings performance helpers", () => {
  it("does not auto-load models when the current model is already in the fallback list", () => {
    expect(
      shouldAutoLoadAiModels(
        { provider: "openrouter", baseUrl: null, currentModel: "openai/gpt-4o-mini" },
        FALLBACK
      )
    ).toBe(false)
  })

  it("auto-loads models when the current model is not in the fallback list", () => {
    expect(
      shouldAutoLoadAiModels(
        { provider: "openrouter", baseUrl: null, currentModel: "anthropic/claude-3.7-sonnet" },
        FALLBACK
      )
    ).toBe(true)
  })

  it("never auto-loads models for the local CLI agent", () => {
    expect(
      shouldAutoLoadAiModels(
        { provider: "cli_agent", baseUrl: null, currentModel: "custom-model" },
        FALLBACK
      )
    ).toBe(false)
  })

  it("auto-loads models for an OpenAI-compatible endpoint only when a base URL is saved", () => {
    expect(
      shouldAutoLoadAiModels(
        { provider: "openai_compatible", baseUrl: null, currentModel: "llama3.2" },
        FALLBACK
      )
    ).toBe(false)
    expect(
      shouldAutoLoadAiModels(
        { provider: "openai_compatible", baseUrl: "  ", currentModel: "llama3.2" },
        FALLBACK
      )
    ).toBe(false)
    expect(
      shouldAutoLoadAiModels(
        {
          provider: "openai_compatible",
          baseUrl: "http://localhost:11434/v1",
          currentModel: "llama3.2",
        },
        FALLBACK
      )
    ).toBe(true)
  })
})
