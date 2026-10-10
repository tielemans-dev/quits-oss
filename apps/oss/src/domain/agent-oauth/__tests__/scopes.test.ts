import { describe, expect, it } from "vitest"
import { getConnectorPreset, parseScopeParameter, presetScopesFor, suggestPreset } from "../scopes"

describe("connector scopes", () => {
  it("keeps the draft-only preset free of anything that sends or moves money", () => {
    const scopes = presetScopesFor(getConnectorPreset("drafting_only")!, ["admin"])
    expect(scopes).toEqual(expect.arrayContaining(["invoice:create", "invoice:update", "contact:create"]))
    for (const outward of ["invoice:send", "quote:send", "agreement:send", "creditNote:create", "payment:create", "payment:void"]) {
      expect(scopes).not.toContain(outward)
    }
    expect(getConnectorPreset("drafting_only")!.mode).toBe("approval_required")
  })

  it("never grants more than the person's role or agent management", () => {
    const full = getConnectorPreset("full_access")!
    expect(presetScopesFor(full, ["admin"]).some((scope) => scope.startsWith("agent:"))).toBe(false)
    expect(presetScopesFor(full, ["accountant"])).not.toContain("invoice:create")
    expect(presetScopesFor(getConnectorPreset("drafting_only")!, ["accountant"])).not.toContain("invoice:create")
  })

  it("parses scope parameters and reports unknown or ungrantable scopes", () => {
    expect(parseScopeParameter("invoice:read  offline_access contact:read invoice:read")).toEqual({
      scopes: ["invoice:read", "contact:read"],
      unknown: [],
    })
    expect(parseScopeParameter("agent:create files:read").unknown).toEqual(["agent:create", "files:read"])
    expect(parseScopeParameter(null)).toEqual({ scopes: [], unknown: [] })
  })

  it("preselects the narrowest preset and never full access", () => {
    expect(suggestPreset(["invoice:read"], ["admin"])).toBe("read_only")
    expect(suggestPreset(["invoice:create"], ["admin"])).toBe("drafting_only")
    expect(suggestPreset(["invoice:send"], ["admin"])).toBe("drafting_with_approved_sending")
    expect(suggestPreset(["payment:void"], ["admin"])).toBe("drafting_with_approved_sending")
  })
})
