import { createAccessControl } from "better-auth/plugins/access"
import {
  defaultStatements,
  adminAc,
  memberAc,
} from "better-auth/plugins/organization/access"

const statement = {
  ...defaultStatements,
  invoice: ["create", "read", "update", "delete", "send"],
  quote: ["create", "read", "update", "delete", "send"],
  creditNote: ["create", "read", "send"],
  payment: ["create", "read", "void"],
  recurring: ["create", "read", "update"],
  catalog: ["create", "read", "update"],
  contact: ["create", "read", "update", "delete"],
  settings: ["read", "update"],
  agent: ["create", "read", "revoke"],
  export: ["read"],
  audit: ["read"],
} as const

export const ac = createAccessControl(statement)

export const adminGrants = {
  invoice: ["create", "read", "update", "delete", "send"],
  quote: ["create", "read", "update", "delete", "send"],
  creditNote: ["create", "read", "send"],
  payment: ["create", "read", "void"],
  recurring: ["create", "read", "update"],
  catalog: ["create", "read", "update"],
  contact: ["create", "read", "update", "delete"],
  settings: ["read", "update"],
  agent: ["create", "read", "revoke"],
  export: ["read"],
  audit: ["read"],
} as const

export const memberGrants = {
  invoice: ["create", "read", "update", "send"],
  quote: ["create", "read", "update", "send"],
  creditNote: ["create", "read", "send"],
  payment: ["create", "read"],
  recurring: ["create", "read", "update"],
  catalog: ["create", "read", "update"],
  contact: ["create", "read", "update"],
  settings: ["read"],
  export: ["read"],
} as const

export const accountantGrants = {
  invoice: ["read"],
  quote: ["read"],
  creditNote: ["read"],
  payment: ["read"],
  recurring: ["read"],
  catalog: ["read"],
  contact: ["read"],
  settings: ["read"],
  export: ["read"],
  audit: ["read"],
} as const

export const admin = ac.newRole({
  ...adminAc.statements,
  ...adminGrants,
})

export const member = ac.newRole({
  ...memberAc.statements,
  ...memberGrants,
})

export const accountant = ac.newRole(accountantGrants)
