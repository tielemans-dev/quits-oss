import { useRef, useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

import { Button } from "../ui/button"
import { FillSlot } from "../ui/fill-slot"
import { useI18n } from "../../lib/i18n/react"

/** Mercury's settings rows: hairline-separated, label and description left, value and actions right. */
export function SettingsRows({ children }: { children: ReactNode }) {
  return <div className="border-t border-hairline">{children}</div>
}

/**
 * One setting. It shows the saved value with "Edit ›"; editing reveals the controls in place.
 * The controls stay mounted while hidden, so a shared form still submits them. With `formId`,
 * the row's Save submits that form, and the row closes when `savedVersion` changes after a
 * successful save. Without it the controls bring their own actions.
 */
export function SettingsRow({
  label,
  description,
  value,
  formId,
  savedVersion,
  children,
}: {
  label: string
  description?: string
  value: ReactNode
  formId?: string
  savedVersion?: number
  children?: ReactNode
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [seenVersion, setSeenVersion] = useState(savedVersion)
  if (savedVersion !== seenVersion) {
    setSeenVersion(savedVersion)
    setEditing(false)
  }
  const editor = useRef<HTMLDivElement>(null)

  function cancel() {
    // Uncontrolled fields go back to what was saved.
    editor.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=file]):not([type=radio]), textarea")
      .forEach((field) => { field.value = field.defaultValue })
    setEditing(false)
  }

  return (
    <div data-slot="settings-row" className="grid gap-2 border-b border-hairline py-5 md:grid-cols-2 md:gap-8">
      {/* Mounting filled plays the fill once, so a page fills in where its loading rows were. */}
      <FillSlot as="div" filled width="40%" className="self-start">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{label}</p>
          {description ? <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p> : null}
        </div>
      </FillSlot>
      <div className="min-w-0">
        {editing ? null : (
          <FillSlot as="div" filled width="50%" className="self-start">
            <div className="min-w-0 flex-1">
              <div className="text-sm break-words text-foreground">{value}</div>
              {children ? (
                <button type="button" onClick={() => setEditing(true)} aria-label={`${t("settings.row.edit")} ${label}`}
                  className="mt-1.5 inline-flex items-center gap-0.5 text-sm text-(--brand-text) hover:underline">
                  {t("settings.row.edit")}
                  <ChevronRight className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </FillSlot>
        )}
        <div ref={editor} className={editing ? "grid gap-3" : "hidden"}>
          {children}
          {formId ? (
            <div className="flex gap-2">
              <Button type="submit" form={formId} size="sm">{t("settings.row.save")}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={cancel}>{t("settings.row.cancel")}</Button>
            </div>
          ) : (
            <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={() => setEditing(false)}>{t("settings.row.done")}</Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** A settings page while it loads: rows of skeletons where the rows will fill in. */
export function SettingsRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <SettingsRows>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} data-slot="settings-row" className="grid gap-2 border-b border-hairline py-5 md:grid-cols-2 md:gap-8">
          <FillSlot as="div" filled={false} width="40%" />
          <FillSlot as="div" filled={false} width="50%" />
        </div>
      ))}
    </SettingsRows>
  )
}

/** The muted placeholder for a setting with no value yet. */
export function SettingsEmpty() {
  const { t } = useI18n()
  return <span className="text-muted-foreground">{t("settings.row.empty")}</span>
}
