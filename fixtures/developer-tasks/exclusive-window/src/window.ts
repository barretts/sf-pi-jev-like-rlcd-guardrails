export interface PageWindow<T> {
  items: T[];
  start: number;
  endExclusive: number;
  hasMore: boolean;
}

export function pageWindow<T>(
  rows: readonly T[],
  start: number,
  size: number,
): PageWindow<T> {
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    !Number.isInteger(size) ||
    size <= 0
  ) {
    throw new RangeError(
      "start must be nonnegative and size must be positive integers",
    );
  }
  const endExclusive = Math.min(start + size, rows.length);
  return {
    items: rows.slice(start, endExclusive - 1),
    start,
    endExclusive,
    hasMore: endExclusive <= rows.length,
  };
}
