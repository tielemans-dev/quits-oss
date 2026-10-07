import { accountantGrants, adminGrants, memberGrants } from "../lib/permissions"

type Grants = typeof adminGrants
type ResourceActions = {
  [Resource in keyof Grants]: `${Resource}:${Grants[Resource][number]}`
}

/** A single `resource:action` capability, e.g. `invoice:send`. */
export type Permission = ResourceActions[keyof ResourceActions]

export type OrganizationRole = "admin" | "member" | "accountant"

function flatten(grants: Record<string, readonly string[]>): ReadonlySet<Permission> {
  return new Set(
    Object.entries(grants).flatMap(([resource, actions]) =>
      actions.map((action) => `${resource}:${action}` as Permission)
    )
  )
}

const roleGrants: Record<OrganizationRole, ReadonlySet<Permission>> = {
  admin: flatten(adminGrants),
  member: flatten(memberGrants),
  accountant: flatten(accountantGrants),
}

export const ALL_PERMISSIONS: readonly Permission[] = [...roleGrants.admin]

export function isPermission(value: string): value is Permission {
  return roleGrants.admin.has(value as Permission)
}

/**
 * Better Auth stores roles as a comma-separated string. Unknown roles grant nothing.
 */
export function parseOrganizationRoles(value: string | null | undefined): OrganizationRole[] {
  return (value ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter((role): role is OrganizationRole => role in roleGrants)
}

export function roleHasPermission(roles: readonly OrganizationRole[], permission: Permission) {
  return roles.some((role) => roleGrants[role].has(permission))
}

export function permissionsForRoles(roles: readonly OrganizationRole[]): Permission[] {
  return ALL_PERMISSIONS.filter((permission) => roleHasPermission(roles, permission))
}
