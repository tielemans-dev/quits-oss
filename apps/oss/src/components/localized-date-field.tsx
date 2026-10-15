import { format, isValid, parseISO } from "date-fns"
import { da, enUS } from "date-fns/locale"
import { CalendarIcon, X } from "lucide-react"
import { formatIsoDateForInputDisplay } from "../lib/i18n/date-input"
import { translate } from "../lib/i18n/translate"
import { normalizeLocale } from "../lib/i18n/locale"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"
import { Calendar } from "./ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

type LocalizedDateFieldProps = {
  id?: string
  value: string
  onChange: (value: string) => void
  locale?: string | null
  placeholder: string
  clearLabel?: string
  disabled?: boolean
  required?: boolean
  invalid?: boolean
  describedBy?: string
}

function resolveCalendarLocale(locale?: string | null) {
  const normalized = normalizeLocale(locale).toLowerCase()
  if (normalized.startsWith("da")) return da
  return enUS
}

function parseSelectedDate(value: string) {
  if (!value) return undefined
  const parsed = parseISO(value)
  if (!isValid(parsed)) return undefined
  return parsed
}

export function LocalizedDateField({
  id,
  value,
  onChange,
  locale,
  placeholder,
  clearLabel,
  disabled,
  required,
  invalid,
  describedBy,
}: LocalizedDateFieldProps) {
  const selectedDate = parseSelectedDate(value)
  const displayValue = value ? formatIsoDateForInputDisplay(value, locale) : placeholder

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn("w-full justify-between text-left font-normal", !value && "text-muted-foreground")}
        >
          <span>{displayValue}</span>
          <CalendarIcon className="size-4 shrink-0 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar
          mode="single"
          locale={resolveCalendarLocale(locale)}
          selected={selectedDate}
          onSelect={(date) => onChange(date ? format(date, "yyyy-MM-dd") : "")}
          initialFocus
        />
        {value ? (
          <div className="border-t p-2">
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => onChange("")}>
              <X className="size-4" />
              {clearLabel ?? translate("docForm.clear", locale)}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
