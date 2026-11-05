export type RepositoryInput = { owner: string; name: string };

/**
 * Parse the diagnostics repository field. Both checks share this parser so
 * "owner/name", "https://github.com/owner/name" and trailing slashes are
 * accepted or rejected the same way.
 */
export function parseRepositoryInput(input: string): RepositoryInput | null {
  const normalized = input
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/+$/, "");
  const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}
