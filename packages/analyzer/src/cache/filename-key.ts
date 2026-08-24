// Cache-key filename normalization (analyzer.md §10.2/§10.3's "fix the
// key-normalization spec in one module"). Only path-separator differences
// are normalized here: whether the underlying filesystem is case-sensitive
// varies even across two machines on the same OS (a case-insensitive mount
// on Linux, a case-sensitive APFS volume on macOS), and this package has no
// reliable way to detect that — blindly case-folding could make two
// genuinely different files on a case-sensitive filesystem collide in the
// cache, which is worse than the status quo. Backslash-vs-forward-slash is
// unambiguous: `sourceFilename` values only ever come from a real path
// (never user-typed text), so normalizing separators cannot lose
// information or conflate two different files.
export function normalizeFilenameForCacheKey(filename: string): string {
  return filename.replace(/\\/g, "/");
}
