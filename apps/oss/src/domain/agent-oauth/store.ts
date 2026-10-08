import type { Permission } from "../permissions"
import type { ConnectorPresetId } from "./scopes"

/**
 * PROTOTYPE storage for sign-in grants. Everything here lives in process memory, so it only works
 * with a single app process and is lost on restart; the implementation brief proposes the tables
 * that replace it. The authorization itself is not stored here: every grant points at an agent key
 * (the "installation"), which carries the mode and scopes and is what approvals, revocation,
 * idempotency receipts and role checks already use.
 *
 * Secrets (codes and tokens) are stored only as SHA-256 hashes.
 */

export type RegisteredClient = {
  clientId: string
  clientName: string
  clientUri: string | null
  redirectUris: string[]
  grantTypes: string[]
  /** `dynamic` (RFC 7591) or `metadata_document` (Client ID Metadata Document). */
  registration: "dynamic" | "metadata_document"
  createdAt: Date
  /** Metadata documents are re-fetched after this time. */
  expiresAt: Date | null
}

/** A validated authorization request waiting for the person to decide on the consent page. */
export type PendingAuthorization = {
  id: string
  clientId: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  resource: string
  requestedScopes: Permission[]
  createdAt: Date
  expiresAt: Date
}

export type AuthorizationCode = {
  codeHash: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  resource: string
  agentKeyId: string
  organizationId: string
  userId: string
  scopes: Permission[]
  presetId: ConnectorPresetId
  expiresAt: Date
  usedAt: Date | null
  /** Tokens issued with this code, revoked if the code is ever presented again. */
  familyId: string | null
}

/** A refresh token chain. Rotation keeps the family; reuse of a rotated token revokes it. */
export type TokenFamily = {
  id: string
  clientId: string
  agentKeyId: string
  organizationId: string
  userId: string
  resource: string
  scopes: Permission[]
  presetId: ConnectorPresetId
  createdAt: Date
  revokedAt: Date | null
}

export type RefreshToken = {
  tokenHash: string
  familyId: string
  expiresAt: Date
  rotatedAt: Date | null
}

export type AccessToken = {
  tokenHash: string
  familyId: string
  clientId: string
  agentKeyId: string
  resource: string
  scopes: Permission[]
  expiresAt: Date
}

export interface McpOAuthStore {
  saveClient(client: RegisteredClient): Promise<void>
  getClient(clientId: string): Promise<RegisteredClient | null>
  savePendingAuthorization(request: PendingAuthorization): Promise<void>
  /** Returns and removes the request, so a consent can be decided once. */
  takePendingAuthorization(id: string): Promise<PendingAuthorization | null>
  getPendingAuthorization(id: string): Promise<PendingAuthorization | null>
  saveCode(code: AuthorizationCode): Promise<void>
  getCode(codeHash: string): Promise<AuthorizationCode | null>
  /** Marks a code used; false when it was already used (a replay). */
  markCodeUsed(codeHash: string, usedAt: Date, familyId: string | null): Promise<boolean>
  saveFamily(family: TokenFamily): Promise<void>
  getFamily(id: string): Promise<TokenFamily | null>
  revokeFamily(id: string, at: Date): Promise<void>
  saveRefreshToken(token: RefreshToken): Promise<void>
  getRefreshToken(tokenHash: string): Promise<RefreshToken | null>
  /** Marks a refresh token rotated; false when it already was (a replay). */
  markRefreshTokenRotated(tokenHash: string, at: Date): Promise<boolean>
  saveAccessToken(token: AccessToken): Promise<void>
  getAccessToken(tokenHash: string): Promise<AccessToken | null>
  listFamiliesForAgentKeys(agentKeyIds: readonly string[]): Promise<TokenFamily[]>
}

export class InMemoryMcpOAuthStore implements McpOAuthStore {
  private clients = new Map<string, RegisteredClient>()
  private pending = new Map<string, PendingAuthorization>()
  private codes = new Map<string, AuthorizationCode>()
  private families = new Map<string, TokenFamily>()
  private refreshTokens = new Map<string, RefreshToken>()
  private accessTokens = new Map<string, AccessToken>()

  async saveClient(client: RegisteredClient) {
    this.clients.set(client.clientId, client)
  }
  async getClient(clientId: string) {
    return this.clients.get(clientId) ?? null
  }
  async savePendingAuthorization(request: PendingAuthorization) {
    this.pending.set(request.id, request)
  }
  async takePendingAuthorization(id: string) {
    const request = this.pending.get(id) ?? null
    this.pending.delete(id)
    return request
  }
  async getPendingAuthorization(id: string) {
    return this.pending.get(id) ?? null
  }
  async saveCode(code: AuthorizationCode) {
    this.codes.set(code.codeHash, code)
  }
  async getCode(codeHash: string) {
    return this.codes.get(codeHash) ?? null
  }
  async markCodeUsed(codeHash: string, usedAt: Date, familyId: string | null) {
    const code = this.codes.get(codeHash)
    if (!code || code.usedAt) return false
    this.codes.set(codeHash, { ...code, usedAt, familyId })
    return true
  }
  async saveFamily(family: TokenFamily) {
    this.families.set(family.id, family)
  }
  async getFamily(id: string) {
    return this.families.get(id) ?? null
  }
  async revokeFamily(id: string, at: Date) {
    const family = this.families.get(id)
    if (family && !family.revokedAt) this.families.set(id, { ...family, revokedAt: at })
  }
  async saveRefreshToken(token: RefreshToken) {
    this.refreshTokens.set(token.tokenHash, token)
  }
  async getRefreshToken(tokenHash: string) {
    return this.refreshTokens.get(tokenHash) ?? null
  }
  async markRefreshTokenRotated(tokenHash: string, at: Date) {
    const token = this.refreshTokens.get(tokenHash)
    if (!token || token.rotatedAt) return false
    this.refreshTokens.set(tokenHash, { ...token, rotatedAt: at })
    return true
  }
  async saveAccessToken(token: AccessToken) {
    this.accessTokens.set(token.tokenHash, token)
  }
  async getAccessToken(tokenHash: string) {
    return this.accessTokens.get(tokenHash) ?? null
  }
  async listFamiliesForAgentKeys(agentKeyIds: readonly string[]) {
    const wanted = new Set(agentKeyIds)
    return [...this.families.values()].filter((family) => wanted.has(family.agentKeyId))
  }
}
