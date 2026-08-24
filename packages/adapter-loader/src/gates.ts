/**
 * Trust and specifier gates for external adapters (adapter-loader.md §4
 * item 2, language-server.md §10.2). The runtime shape / apiVersion gate is
 * not duplicated here — it is validator-api's own
 * `checkHtmlValidatorAdapter`, called directly from load.ts.
 */
import type { LoadAdaptersTrust } from "./types.js";

/** §4 item 2 bullet 2: `externalAdapters` must be explicitly opted in. */
export function isExternalAdaptersModeEnabled(
  trust: LoadAdaptersTrust,
): boolean {
  return trust.externalAdapters === "trusted-workspace-only";
}

/** §4 item 2 bullet 3. */
export function isWorkspaceTrusted(trust: LoadAdaptersTrust): boolean {
  return trust.workspaceTrusted === true;
}

// Matches a URL scheme prefix ("http:", "file:", "data:", ...) — also
// catches a Windows drive letter ("C:\..." / "C:/...") since that shape is
// indistinguishable from a scheme without filesystem access, and this gate
// must reject without attempting any resolution.
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const NAME_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * §4 item 2 bullet 4: "a plain npm package name — no paths, URLs, or data
 * URIs". Rejects anything relative/absolute, anything URL-scheme-shaped,
 * any backslash, and any subpath (this gate accepts package names only,
 * not `pkg/subpath` exports) — language-server.md §10.2 describes the
 * result as "similar to an allowlist" in shape, without an actual curated
 * allowlist (ADR-0008).
 */
export function isPlainPackageSpecifier(specifier: string): boolean {
  if (specifier.length === 0 || specifier !== specifier.trim()) return false;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.includes("\\")) return false;
  if (URL_SCHEME_PATTERN.test(specifier)) return false;

  if (specifier.startsWith("@")) {
    const parts = specifier.slice(1).split("/");
    return (
      parts.length === 2 &&
      parts.every((part) => NAME_SEGMENT_PATTERN.test(part))
    );
  }
  return NAME_SEGMENT_PATTERN.test(specifier);
}
