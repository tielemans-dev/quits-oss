import type { ClientBase } from "pg"

/** Runs one parameterised statement and returns its rows. Adapts `pg` clients and Prisma alike. */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>

export function queryFn(client: Pick<ClientBase, "query">): QueryFn {
  return async (sql, params) => (await client.query(sql, params)).rows
}

export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`

export type TableInfo = {
  name: string
  columns: Array<{ name: string; nullable: boolean; hasDefault: boolean }>
  primaryKey: string[]
}

/** Base tables of the current schema with their columns and primary keys. */
export async function readTables(query: QueryFn): Promise<TableInfo[]> {
  const columns = await query(`
    SELECT table_name, column_name, is_nullable = 'YES' AS nullable, column_default IS NOT NULL AS has_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN (SELECT table_name FROM information_schema.tables
                         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE')
    ORDER BY table_name, ordinal_position`)
  const keys = await query(`
    SELECT c.relname AS table_name, a.attname AS column_name, k.ord
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE i.indisprimary
    ORDER BY c.relname, k.ord`)
  const tables = new Map<string, TableInfo>()
  for (const row of columns) {
    const name = String(row.table_name)
    const table = tables.get(name) ?? { name, columns: [], primaryKey: [] }
    table.columns.push({
      name: String(row.column_name),
      nullable: Boolean(row.nullable),
      hasDefault: Boolean(row.has_default),
    })
    tables.set(name, table)
  }
  for (const row of keys) tables.get(String(row.table_name))?.primaryKey.push(String(row.column_name))
  return [...tables.values()]
}

/** Table names ordered so every table comes after the tables its foreign keys point to. */
export async function orderByDependency(query: QueryFn, names: readonly string[]): Promise<string[]> {
  const edges = await query(`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = current_schema()
    WHERE c.contype = 'f'`)
  const unquote = (value: string) => value.replace(/^"|"$/g, "").replace(/^[^.]*\./, "").replace(/^"|"$/g, "")
  const wanted = new Set(names)
  const parents = new Map<string, Set<string>>(names.map((name) => [name, new Set()]))
  for (const edge of edges) {
    const child = unquote(String(edge.child))
    const parent = unquote(String(edge.parent))
    if (child !== parent && wanted.has(child) && wanted.has(parent)) parents.get(child)!.add(parent)
  }
  const ordered: string[] = []
  const remaining = new Set(names)
  while (remaining.size) {
    const ready = [...remaining].filter((name) => [...parents.get(name)!].every((parent) => !remaining.has(parent))).sort()
    if (!ready.length) throw new Error(`Foreign keys form a cycle among: ${[...remaining].join(", ")}`)
    for (const name of ready) {
      ordered.push(name)
      remaining.delete(name)
    }
  }
  return ordered
}

export async function readAppliedMigrations(query: QueryFn): Promise<string[] | null> {
  const exists = await query(`SELECT to_regclass('_prisma_migrations') IS NOT NULL AS present`)
  if (!exists[0]?.present) return null
  const rows = await query(`
    SELECT migration_name FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)
  return rows.map((row) => String(row.migration_name))
}

export async function readPostgresVersion(query: QueryFn) {
  return String((await query(`SHOW server_version`))[0]?.server_version ?? "unknown")
}

/**
 * Timestamps are stored as UTC wall-clock time without a zone, as Prisma writes them. `pg` would
 * read and write them in the client's local zone, so every date goes through these.
 */
export const utcNow = `(now() AT TIME ZONE 'UTC')`
/** A bound Date parameter as UTC wall-clock time. */
export const utcParam = (position: number) => `($${position}::timestamptz AT TIME ZONE 'UTC')`
/** A stored timestamp column as an instant, so it reads back as the right Date. */
export const instant = (column: string) => `(${column} AT TIME ZONE 'UTC')`
