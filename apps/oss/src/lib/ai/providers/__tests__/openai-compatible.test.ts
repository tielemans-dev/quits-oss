import { afterEach, describe, expect, it, vi } from "vitest"
import { AiProviderError } from "../../provider"
import { createOpenAiCompatibleProvider, endpointUrl } from "../openai-compatible"

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const mock = vi.fn(async () => response as Response)
  global.fetch = mock as unknown as typeof fetch
  return mock
}

const openRouter = (apiKey: string | null = "test-key") =>
  createOpenAiCompatibleProvider({
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
  })

const completionRequest = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Create a draft invoice" }],
  temperature: 0.2,
}

describe("createOpenAiCompatibleProvider", () => {
  it("bounds requests with a timeout signal and reports expiry as timeout", async () => {
    const mock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      throw new DOMException("The operation timed out.", "TimeoutError")
    })
    global.fetch = mock as unknown as typeof fetch

    await expect(openRouter().complete(completionRequest)).rejects.toMatchObject({
      code: "timeout",
    })
  })

  it("loads model ids from the models response", async () => {
    stubFetch({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai/gpt-4o-mini" },
          { id: "anthropic/claude-3.5-sonnet" },
          { id: "  openai/gpt-4o-mini  " },
          { id: "   " },
          {},
        ],
      }),
    })

    await expect(openRouter().listModels?.()).resolves.toEqual([
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o-mini",
    ])
  })

  it("sends the bearer token and JSON body to chat completions", async () => {
    const fetchMock = stubFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Hello" } }] }),
    })

    await expect(openRouter().complete(completionRequest)).resolves.toBe("Hello")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(init.body as string)).toEqual({
      model: "openai/gpt-4o-mini",
      messages: completionRequest.messages,
      temperature: 0.2,
    })
  })

  it("does not send an Authorization header when apiKey is null", async () => {
    const fetchMock = stubFetch({
      ok: true,
      json: async () => ({ data: [{ id: "llama3.2" }] }),
    })

    const provider = createOpenAiCompatibleProvider({
      id: "openai_compatible",
      baseUrl: "http://localhost:11434/v1",
      apiKey: null,
    })
    await expect(provider.listModels?.()).resolves.toEqual(["llama3.2"])

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://localhost:11434/v1/models")
    expect(init.headers).toEqual({})
    expect(init.body).toBeUndefined()
  })

  it("strips trailing slashes from the base url", async () => {
    const fetchMock = stubFetch({
      ok: true,
      json: async () => ({ data: [] }),
    })

    const provider = createOpenAiCompatibleProvider({
      id: "openai_compatible",
      baseUrl: "http://localhost:1234/v1///",
      apiKey: null,
    })
    await provider.listModels?.()

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://localhost:1234/v1/models")
  })

  it("throws http error with status and body when the models endpoint returns non-ok", async () => {
    stubFetch({
      ok: false,
      status: 500,
      text: async () => "server error",
    })

    await expect(openRouter().listModels?.()).rejects.toMatchObject({
      name: "AiProviderError",
      code: "http",
      providerId: "openrouter",
      message: expect.stringContaining("500"),
    })
  })

  it("throws http error with status when chat completions returns non-ok", async () => {
    stubFetch({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    })

    const error = await openRouter()
      .complete(completionRequest)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AiProviderError)
    expect(error).toMatchObject({ code: "http", providerId: "openrouter" })
    expect((error as Error).message).toContain("401")
    expect((error as Error).message).toContain("unauthorized")
  })

  it("truncates http error bodies to 500 characters", async () => {
    stubFetch({
      ok: false,
      status: 502,
      text: async () => "x".repeat(2000),
    })

    const error = (await openRouter()
      .complete(completionRequest)
      .catch((caught: unknown) => caught)) as Error

    expect(error.message.endsWith("x".repeat(500))).toBe(true)
    expect(error.message).not.toContain("x".repeat(501))
  })

  it("throws network error when fetch rejects", async () => {
    global.fetch = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch

    await expect(openRouter().complete(completionRequest)).rejects.toMatchObject({
      code: "network",
      providerId: "openrouter",
    })
  })

  it("throws invalid_response when the models payload shape is invalid", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ data: "not-an-array" }),
    })

    await expect(openRouter().listModels?.()).rejects.toMatchObject({
      code: "invalid_response",
      providerId: "openrouter",
    })
  })

  it("throws invalid_response when the response body is not JSON", async () => {
    stubFetch({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token")
      },
    })

    await expect(openRouter().complete(completionRequest)).rejects.toMatchObject({
      code: "invalid_response",
    })
  })

  it("throws empty_response when the completion content is blank", async () => {
    stubFetch({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "   " } }],
      }),
    })

    await expect(openRouter().complete(completionRequest)).rejects.toMatchObject({
      code: "empty_response",
      providerId: "openrouter",
    })
  })

  it("throws empty_response when the completion has no choices", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ choices: [] }),
    })

    await expect(openRouter().complete(completionRequest)).rejects.toMatchObject({
      code: "empty_response",
    })
  })

  it("reports the generic endpoint name for non-OpenRouter providers", async () => {
    stubFetch({
      ok: false,
      status: 404,
      text: async () => "not found",
    })

    const provider = createOpenAiCompatibleProvider({
      id: "openai_compatible",
      baseUrl: "http://localhost:1234/v1",
      apiKey: null,
    })

    await expect(provider.complete(completionRequest)).rejects.toMatchObject({
      code: "http",
      providerId: "openai_compatible",
      message: expect.stringContaining("AI endpoint"),
    })
  })
})

describe("endpointUrl", () => {
  it("appends the route to the path and keeps the query string", () => {
    expect(endpointUrl("https://host/v1?tenant=x", "chat/completions")).toBe(
      "https://host/v1/chat/completions?tenant=x"
    )
    expect(endpointUrl("http://localhost:11434/v1/", "models")).toBe(
      "http://localhost:11434/v1/models"
    )
    expect(endpointUrl("https://host/v1#frag", "models")).toBe("https://host/v1/models")
  })
})
