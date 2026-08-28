const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_ROWS = 50_000;

export async function fetchAllRows(sb, {
  table,
  select = '*',
  orderBy = [],
  pageSize = DEFAULT_PAGE_SIZE,
  maxRows = DEFAULT_MAX_ROWS,
} = {}) {
  if (!table) throw new Error('PAGINATED_TABLE_REQUIRED');
  const safePageSize = Math.max(1, Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE));
  const safeMaxRows = Math.max(safePageSize, Number(maxRows) || DEFAULT_MAX_ROWS);
  const rows = [];

  while (rows.length < safeMaxRows) {
    const from = rows.length;
    const to = Math.min(from + safePageSize, safeMaxRows) - 1;
    let query = sb.from(table).select(select);
    for (const spec of Array.isArray(orderBy) ? orderBy : []) {
      if (!spec?.column) continue;
      query = query.order(spec.column, {
        ascending: spec.ascending !== false,
        ...(typeof spec.nullsFirst === 'boolean' ? { nullsFirst: spec.nullsFirst } : {}),
      });
    }
    const { data, error } = await query.range(from, to);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < (to - from + 1)) return rows;
  }

  throw new Error(`PAGINATED_READ_LIMIT_REACHED_${table}_${safeMaxRows}`);
}

export async function fetchAllRowsResult(sb, options) {
  try {
    return { data: await fetchAllRows(sb, options), error: null };
  } catch (error) {
    return { data: [], error };
  }
}
