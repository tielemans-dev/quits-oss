import { describe, expect, it } from "vitest"
import { isAiEndpointHostAllowed } from "../provider"

describe("isAiEndpointHostAllowed", () => {
  it("allows any host when the operator has not set a list", () => {
    expect(isAiEndpointHostAllowed("http://10.0.0.5:8080/v1", {})).toBe(true)
  })

  it("only allows listed hosts, with or without a port", () => {
    const env = { QUITS_AI_CUSTOM_ENDPOINT_HOSTS: "localhost:11434, LLM.internal" }

    expect(isAiEndpointHostAllowed("http://localhost:11434/v1", env)).toBe(true)
    expect(isAiEndpointHostAllowed("https://llm.internal/v1", env)).toBe(true)
    expect(isAiEndpointHostAllowed("http://localhost:6379", env)).toBe(false)
    expect(isAiEndpointHostAllowed("http://169.254.169.254/latest", env)).toBe(false)
  })

  it("matches an entry that names the protocol's default port", () => {
    const env = { QUITS_AI_CUSTOM_ENDPOINT_HOSTS: "api.example.com:443,plain.example.com:80" }

    expect(isAiEndpointHostAllowed("https://api.example.com:443/v1", env)).toBe(true)
    expect(isAiEndpointHostAllowed("https://api.example.com/v1", env)).toBe(true)
    expect(isAiEndpointHostAllowed("http://plain.example.com/v1", env)).toBe(true)
    expect(isAiEndpointHostAllowed("http://api.example.com/v1", env)).toBe(false)
  })
})
