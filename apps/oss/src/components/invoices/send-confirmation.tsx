import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "../ui/sheet"

export function SendConfirmation({ open, onOpenChange, number, recipient, amount, dueDate, pending, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; number?: string; recipient: string;
  amount: string; dueDate: string; pending: boolean; onConfirm: () => void;
}) {
  const { t } = useI18n()
  return <Sheet open={open} onOpenChange={value => { if (!pending) onOpenChange(value) }}>
    <SheetContent side="bottom" className="mx-auto max-w-xl rounded-t-xl" showCloseButton={!pending}>
      <SheetHeader>
        <SheetTitle>{number ? t("invoiceSend.title", { number }) : t("invoiceSend.titleWithoutNumber")}</SheetTitle>
        <SheetDescription>{t("invoiceSend.body", { recipient, amount, dueDate })}</SheetDescription>
      </SheetHeader>
      <SheetFooter className="gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{t("invoiceSend.cancel")}</Button>
        <Button disabled={pending} onClick={onConfirm}>{pending ? t("invoices.detail.action.sending") : t("invoiceSend.confirm")}</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
}
