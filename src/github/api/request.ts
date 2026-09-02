import type { z } from "zod";

import { withOptionalSignal } from "../request-init";
import { errorResponseSchema } from "./schemas";
import {
  GitHubApiError,
  GitHubApiSchemaError,
  type GitHubEndpointDescriptor,
  type GitHubRateLimitSnapshot,
} from "./types";

export function createGitHubHeaders(token?: string | null): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}

export function fetchGitHubApiResponse(
  url: string,
  headers: Headers,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, withOptionalSignal({ headers }, signal));
}

export async function createGitHubApiErrorFromResponse(
  response: Response,
  endpoint: GitHubEndpointDescriptor,
): Promise<GitHubApiError | null> {
  if (response.ok) {
    return null;
  }

  return createGitHubApiError(response, endpoint);
}

export async function createGitHubApiError(
  response: Response,
  endpoint?: GitHubEndpointDescriptor,
): Promise<GitHubApiError> {
  const payload = errorResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  return new GitHubApiError(
    response.status,
    payload.success ? payload.data.message : undefined,
    endpoint,
    readRateLimitSnapshot(response),
  );
}

export async function collectGitHubApiPages<T>(params: {
  firstResponse: Response;
  endpoint: GitHubEndpointDescriptor;
  headers: Headers;
  schema: z.ZodType<T[]>;
  signal?: AbortSignal;
  pageBudget?: number;
  hasEnough?: (collected: T[]) => boolean;
  mapNextPageError?: (error: GitHubApiError) => Error;
}): Promise<T[]> {
  const collected: T[] = [];
  const expectedPathname = params.endpoint.path.split("?")[0];

  let response = params.firstResponse;
  let pageCount = 0;
  while (true) {
    const parsed = params.schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GitHubApiSchemaError(params.endpoint, parsed.error.issues);
    }
    collected.push(...parsed.data);
    pageCount += 1;

    if (
      params.hasEnough?.(collected) === true ||
      (params.pageBudget != null && pageCount >= params.pageBudget)
    ) {
      return collected;
    }

    const nextUrl = parseNextPageUrl(
      response.headers.get("Link"),
      expectedPathname,
    );
    if (nextUrl == null) {
      return collected;
    }

    response = await fetchGitHubApiResponse(
      nextUrl,
      params.headers,
      params.signal,
    );

    const error = await createGitHubApiErrorFromResponse(
      response,
      params.endpoint,
    );
    if (error != null) {
      throw params.mapNextPageError?.(error) ?? error;
    }
  }
}

export function parseNextPageUrl(
  linkHeader: string | null,
  expectedPathname?: string,
): string | null {
  if (linkHeader == null) {
    return null;
  }

  for (const segment of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(segment.trim());
    if (match == null) {
      continue;
    }
    const rels = match[2].split(/\s+/);
    if (rels.includes("next")) {
      if (
        expectedPathname != null &&
        !isExpectedGitHubApiUrl(match[1], expectedPathname)
      ) {
        return null;
      }
      return match[1];
    }
  }

  return null;
}

function isExpectedGitHubApiUrl(
  url: string,
  expectedPathname: string,
): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://api.github.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === expectedPathname &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function readRateLimitSnapshot(response: Response): GitHubRateLimitSnapshot {
  return {
    limit: readHeaderNumber(response.headers, "x-ratelimit-limit"),
    remaining: readHeaderNumber(response.headers, "x-ratelimit-remaining"),
    resource: response.headers.get("x-ratelimit-resource"),
    resetAt: readHeaderNumber(response.headers, "x-ratelimit-reset"),
  };
}

function readHeaderNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value == null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
