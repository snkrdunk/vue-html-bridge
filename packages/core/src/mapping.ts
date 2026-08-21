import type { GeneratedRange, MappingEntry, SourceOrigin } from "./types.js";

export function findSourceOrigins(
  map: readonly MappingEntry[],
  generatedRange: GeneratedRange,
): readonly SourceOrigin[] {
  if (generatedRange.start === generatedRange.end) {
    return pointOrigins(map, generatedRange.start);
  }
  const candidates = map
    .map((entry) => ({
      entry,
      overlap: Math.max(
        0,
        Math.min(entry.generated.end, generatedRange.end) -
          Math.max(entry.generated.start, generatedRange.start),
      ),
    }))
    .filter((origin) => origin.overlap > 0);
  if (candidates.length === 0) return [];
  const maxOverlap = Math.max(...candidates.map((item) => item.overlap));
  const overlapWinners = candidates.filter(
    (item) => item.overlap === maxOverlap,
  );
  const containing = overlapWinners.filter(
    ({ entry }) =>
      entry.generated.start <= generatedRange.start &&
      entry.generated.end >= generatedRange.end,
  );
  const pool = containing.length > 0 ? containing : overlapWinners;
  const minLength = Math.min(
    ...pool.map(({ entry }) => entry.generated.end - entry.generated.start),
  );
  return pool
    .filter(
      ({ entry }) => entry.generated.end - entry.generated.start === minLength,
    )
    .sort(compareOrigins);
}

function pointOrigins(
  map: readonly MappingEntry[],
  point: number,
): readonly SourceOrigin[] {
  const containing = map.filter(
    (entry) => entry.generated.start <= point && point < entry.generated.end,
  );
  if (containing.length > 0) {
    const minLength = Math.min(
      ...containing.map((entry) => entry.generated.end - entry.generated.start),
    );
    return containing
      .filter(
        (entry) => entry.generated.end - entry.generated.start === minLength,
      )
      .map((entry) => ({ entry, overlap: 0 }))
      .sort(compareOrigins);
  }
  const ending = map.filter((entry) => entry.generated.end === point);
  const starting = map.filter((entry) => entry.generated.start === point);
  const boundary = ending.length > 0 ? ending : starting;
  if (boundary.length === 0) return [];
  const minLength = Math.min(
    ...boundary.map((entry) => entry.generated.end - entry.generated.start),
  );
  return boundary
    .filter(
      (entry) => entry.generated.end - entry.generated.start === minLength,
    )
    .map((entry) => ({ entry, overlap: 0 }))
    .sort(compareOrigins);
}

function compareOrigins(left: SourceOrigin, right: SourceOrigin): number {
  return (
    right.overlap - left.overlap ||
    left.entry.generated.start - right.entry.generated.start ||
    left.entry.source.start - right.entry.source.start
  );
}
