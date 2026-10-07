import type { TranslationKey } from "../../lib/i18n/messages"
import { useI18n } from "../../lib/i18n/react"

function groupScopes(scopes: readonly string[]) {
  const groups = new Map<string, string[]>()
  for (const scope of scopes) {
    const [resource = scope] = scope.split(":")
    groups.set(resource, [...(groups.get(resource) ?? []), scope])
  }
  return [...groups.entries()]
}

/** Per-scope checkboxes, grouped by resource. Only offers scopes the current user holds. */
export function ScopePicker({
  available,
  selected,
  onChange,
}: {
  available: readonly string[]
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
}) {
  const { t } = useI18n()

  function toggle(scope: string, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(scope)
    else next.delete(scope)
    onChange(next)
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {groupScopes(available).map(([resource, scopes]) => (
        <fieldset key={resource} className="grid gap-1.5 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">
            {t(`agents.scopeGroup.${resource}` as TranslationKey)}
          </legend>
          {scopes.map((scope) => (
            <label key={scope} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(scope)}
                onChange={(event) => toggle(scope, event.target.checked)}
              />
              <span className="font-mono text-xs">{scope}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  )
}
