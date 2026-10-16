/**
 * Paginates Supabase PostgREST queries past the default max_rows = 1000 limit.
 * Repeats .range(from, from + pageSize - 1) until fewer than pageSize rows
 * are returned. Throws on any Supabase error.
 */
export async function fetchAll<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const results: T[] = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await build(from, to);

    if (error) {
      const msg =
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error);
      throw new Error(`Supabase paginated query failed: ${msg}`);
    }

    const batch = data ?? [];
    for (let i = 0; i < batch.length; i++) {
      results.push(batch[i]);
    }

    if (batch.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return results;
}

