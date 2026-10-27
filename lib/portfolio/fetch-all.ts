/**
 * Paginates Supabase PostgREST queries past the default max_rows = 1000 limit.
 *
 * If the initial query returns `count` (e.g. from `.select(..., { count: 'exact' })`),
 * remaining pages are fetched concurrently with a bounded pool (default concurrency: 6).
 * Otherwise, falls back to a sequential loop. Throws on any Supabase error.
 */
export async function fetchAll<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>,
  pageSize = 1000,
  concurrency = 6,
): Promise<T[]> {
  // 1. Fetch initial page (0 to pageSize - 1)
  const first = await build(0, pageSize - 1);

  if (first.error) {
    const msg =
      typeof first.error === "object" &&
      first.error !== null &&
      "message" in first.error &&
      typeof (first.error as { message: unknown }).message === "string"
        ? (first.error as { message: string }).message
        : String(first.error);
    throw new Error(`Supabase paginated query failed: ${msg}`);
  }

  const firstBatch = first.data ?? [];

  // If first batch is less than pageSize, we have the complete result in 1 call
  if (firstBatch.length < pageSize) {
    return firstBatch;
  }

  // 2. If total row count is provided, fetch remaining pages concurrently
  if (typeof first.count === "number" && first.count > pageSize) {
    const totalCount = first.count;
    const ranges: { from: number; to: number; index: number }[] = [];
    let pageIndex = 1;

    for (let from = pageSize; from < totalCount; from += pageSize) {
      const to = Math.min(from + pageSize - 1, totalCount - 1);
      ranges.push({ from, to, index: pageIndex++ });
    }

    const pagesResults: T[][] = new Array(ranges.length);
    let nextIdx = 0;

    const worker = async () => {
      while (nextIdx < ranges.length) {
        const item = ranges[nextIdx++];
        const res = await build(item.from, item.to);
        if (res.error) {
          const msg =
            typeof res.error === "object" &&
            res.error !== null &&
            "message" in res.error &&
            typeof (res.error as { message: unknown }).message === "string"
              ? (res.error as { message: string }).message
              : String(res.error);
          throw new Error(`Supabase paginated query failed: ${msg}`);
        }
        pagesResults[item.index - 1] = res.data ?? [];
      }
    };

    const workerCount = Math.min(concurrency, ranges.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    const results: T[] = [...firstBatch];
    for (let i = 0; i < pagesResults.length; i++) {
      const page = pagesResults[i];
      if (page) {
        for (let j = 0; j < page.length; j++) {
          results.push(page[j]);
        }
      }
    }

    return results;
  }

  // 3. Fallback: sequential loop if count was not requested or unknown
  const results: T[] = [...firstBatch];
  let from = pageSize;

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

