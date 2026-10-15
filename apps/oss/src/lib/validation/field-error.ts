export type FieldError<Field extends string> = { field: Field; message: string }

/**
 * A submit-time validation error belongs to one field. It stays visible only while that field is
 * still invalid, so fixing the field clears the message without waiting for the next submit.
 */
export function visibleFieldError<Field extends string>(
  error: FieldError<Field> | null,
  invalidFields: ReadonlySet<Field>
): string | null {
  return error && invalidFields.has(error.field) ? error.message : null
}
