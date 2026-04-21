import type { ExtensionSettings, TokenEntry } from "./settings";

export type ParsedTokenScope = {
  owner: string;
  repo: string | null;
  scopeType: "owner" | "repo";
  scope: string;
};

type ScopeValidationResult =
  | {
      ok: true;
      scope: string;
    }
  | {
      ok: false;
      message: string;
    };

const OWNER_SEGMENT_PATTERN = /^[^/\s]+$/;
const REPO_SEGMENT_PATTERN = /^[^/\s]+$/;

export type { TokenEntry };

export function createScopeString(owner: string, repo: string | null): string {
  const normalizedOwner = normalizeOwnerSegment(owner);
  const normalizedRepo = repo == null ? null : normalizeRepoSegment(repo);

  return normalizedRepo == null
    ? `${normalizedOwner}/*`
    : `${normalizedOwner}/${normalizedRepo}`;
}

export function validateTokenScopeParts(
  owner: string,
  repo: string | null,
): ScopeValidationResult {
  const normalizedOwner = normalizeOwnerSegment(owner);
  if (!normalizedOwner) {
    return {
      ok: false,
      message: "Owner is required and must not contain slashes or spaces.",
    };
  }

  if (repo == null) {
    return {
      ok: true,
      scope: createScopeString(normalizedOwner, null),
    };
  }

  const trimmedRepo = repo.trim();
  if (!trimmedRepo) {
    return {
      ok: false,
      message: "Repository name is required for single-repository scope.",
    };
  }

  if (trimmedRepo.includes("/")) {
    return {
      ok: false,
      message: "Repository name must not contain slashes.",
    };
  }

  const normalizedRepo = normalizeRepoSegment(trimmedRepo);
  if (!normalizedRepo) {
    return {
      ok: false,
      message: "Repository name must not contain spaces.",
    };
  }

  return {
    ok: true,
    scope: createScopeString(normalizedOwner, normalizedRepo),
  };
}

export function parseTokenScope(scope: string): ParsedTokenScope | null {
  const normalizedScope = scope.trim().replace(/^\/+|\/+$/g, "");
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(normalizedScope);

  if (match == null) {
    return null;
  }

  if (match[2] === "*") {
    return {
      owner: match[1],
      repo: null,
      scopeType: "owner",
      scope: `${match[1]}/*`,
    };
  }

  return {
    owner: match[1],
    repo: match[2],
    scopeType: "repo",
    scope: `${match[1]}/${match[2]}`,
  };
}

export function findDuplicateTokenScope(
  entries: TokenEntry[],
  scope: string,
): TokenEntry | null {
  const normalizedScope = parseTokenScope(scope)?.scope;
  if (normalizedScope == null) {
    return null;
  }

  return (
    entries.find((entry) => parseTokenScope(entry.scope)?.scope === normalizedScope) ??
    null
  );
}

export function resolveTokenEntryForRepository(
  settings: ExtensionSettings,
  repository: string,
): TokenEntry | null {
  const parsedRepository = parseRepositoryReference(repository);
  if (parsedRepository == null) {
    return null;
  }

  const exactScope = createScopeString(
    parsedRepository.owner,
    parsedRepository.repo,
  );
  const ownerScope = createScopeString(parsedRepository.owner, null);

  return (
    settings.tokenEntries.find((entry) => entry.scope === exactScope) ??
    settings.tokenEntries.find((entry) => entry.scope === ownerScope) ??
    null
  );
}

export function maskToken(token: string): string {
  return `••••${token.slice(-4)}`;
}

function parseRepositoryReference(repository: string): {
  owner: string;
  repo: string;
} | null {
  const normalized = repository.trim().replace(/^https:\/\/github\.com\//, "");
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(normalized);

  if (match == null || match[2] === "*") {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

function normalizeOwnerSegment(owner: string): string | null {
  const normalized = owner.trim().replace(/^\/+|\/+$/g, "");
  return OWNER_SEGMENT_PATTERN.test(normalized) ? normalized : null;
}

function normalizeRepoSegment(repo: string): string | null {
  const normalized = repo.trim().replace(/^\/+|\/+$/g, "");
  return REPO_SEGMENT_PATTERN.test(normalized) ? normalized : null;
}
