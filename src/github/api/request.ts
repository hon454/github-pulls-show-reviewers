import type { z } from "zod";
import {
  throwIfReviewerAborted,
  waitForReviewerSignal,
} from "../../shared/reviewer-deadline";

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
  throwIfReviewerAborted(signal);
  return waitForReviewerSignal(
    fetch(url, withOptionalSignal({ headers }, signal)),
    signal,
  );
}

export function readGitHubResponseJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfReviewerAborted(signal);
  return waitForReviewerSignal(response.json(), signal);
}

export async function createGitHubApiErrorFromResponse(
  response: Response,
  endpoint: GitHubEndpointDescriptor,
  signal?: AbortSignal,
): Promise<GitHubApiError | null> {
  if (response.ok) {
    return null;
  }

  return createGitHubApiError(response, endpoint, signal);
}

export async function createGitHubApiError(
  response: Response,
  endpoint?: GitHubEndpointDescriptor,
  signal?: AbortSignal,
): Promise<GitHubApiError> {
  let rawPayload: unknown = null;
  try {
    rawPayload = await readGitHubResponseJson(response, signal);
  } catch (error) {
    throwIfReviewerAborted(signal);
    if (isAbortError(error)) {
      throw error;
    }
  }
  const payload = errorResponseSchema.safeParse(rawPayload);
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
  const result = await collectGitHubApiPagesDetailed(params);
  if (result.status === "unavailable") {
    throw result.error;
  }
  return result.items;
}

export type GitHubApiPageCollection<T> =
  | {
      items: T[];
      status: "complete" | "truncated";
    }
  | {
      items: T[];
      status: "unavailable";
      error: unknown;
    };

export async function collectGitHubApiPagesDetailed<T>(params: {
  firstResponse: Response;
  endpoint: GitHubEndpointDescriptor;
  headers: Headers;
  schema: z.ZodType<T[]>;
  signal?: AbortSignal;
  pageBudget?: number;
  hasEnough?: (collected: T[]) => boolean;
  mapNextPageError?: (error: GitHubApiError) => Error;
}): Promise<GitHubApiPageCollection<T>> {
  const collected: T[] = [];
  const expectedPathname = params.endpoint.path.split("?")[0];
  let followedPathname: string | null = null;
  const visitedPageUrls = new Set<string>();
  if (params.firstResponse.url !== "") {
    visitedPageUrls.add(params.firstResponse.url);
  }

  let response = params.firstResponse;
  let pageCount = 0;
  while (true) {
    try {
      const parsed = params.schema.safeParse(
        await readGitHubResponseJson(response, params.signal),
      );
      throwIfReviewerAborted(params.signal);
      if (!parsed.success) {
        throw new GitHubApiSchemaError(params.endpoint, parsed.error.issues);
      }
      collected.push(...parsed.data);
      pageCount += 1;
    } catch (error) {
      return { items: collected, status: "unavailable", error };
    }

    if (params.hasEnough?.(collected) === true) {
      return { items: collected, status: "complete" };
    }

    const nextPage = inspectNextPageUrl(
      response.headers.get("Link"),
      expectedPathname,
    );
    if (nextPage.status === "none") {
      return { items: collected, status: "complete" };
    }
    if (nextPage.status === "invalid") {
      return { items: collected, status: "truncated" };
    }
    // Later links must keep addressing the repository the first one named.
    const nextPathname = new URL(nextPage.url).pathname;
    if (
      (params.pageBudget != null && pageCount >= params.pageBudget) ||
      visitedPageUrls.has(nextPage.url) ||
      (followedPathname != null && nextPathname !== followedPathname)
    ) {
      return { items: collected, status: "truncated" };
    }
    visitedPageUrls.add(nextPage.url);
    followedPathname = nextPathname;

    try {
      response = await fetchGitHubApiResponse(
        nextPage.url,
        params.headers,
        params.signal,
      );

      const error = await createGitHubApiErrorFromResponse(
        response,
        params.endpoint,
        params.signal,
      );
      if (error != null) {
        throw params.mapNextPageError?.(error) ?? error;
      }
    } catch (error) {
      return { items: collected, status: "unavailable", error };
    }
  }
}

export function parseNextPageUrl(
  linkHeader: string | null,
  expectedPathname?: string,
): string | null {
  const result = inspectNextPageUrl(linkHeader, expectedPathname);
  return result.status === "valid" ? result.url : null;
}

/**
 * Returns the validated `rel="last"` URL only when it is a page beyond the
 * validated `rel="next"` one and addresses the same repository path, i.e. the
 * collection spans more than two pages. Null means "follow next as usual".
 */
export function parseSkippedLastPageUrl(
  linkHeader: string | null,
  expectedPathname: string,
): string | null {
  const next = inspectPageLink(linkHeader, "next", expectedPathname);
  const last = inspectPageLink(linkHeader, "last", expectedPathname);
  if (next.status !== "valid" || last.status !== "valid") return null;
  if (next.url === last.url) return null;
  return new URL(next.url).pathname === new URL(last.url).pathname
    ? last.url
    : null;
}

type NextPageInspection =
  { status: "none" } | { status: "invalid" } | { status: "valid"; url: string };

function inspectNextPageUrl(
  linkHeader: string | null,
  expectedPathname?: string,
): NextPageInspection {
  return inspectPageLink(linkHeader, "next", expectedPathname);
}

function inspectPageLink(
  linkHeader: string | null,
  relationName: "next" | "last",
  expectedPathname?: string,
): NextPageInspection {
  if (linkHeader == null) {
    return { status: "none" };
  }

  let hasMalformedRelation = false;
  for (const segment of linkHeader.split(",")) {
    const match = /^<([^<>]+)>(.*)$/.exec(segment.trim());
    if (match == null) {
      hasMalformedRelation ||= /\brel\b/i.test(segment);
      continue;
    }

    const parameters = match[2].trim();
    const relation =
      /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))(?=\s*(?:;|$))/i.exec(
        parameters,
      );
    if (relation == null) {
      hasMalformedRelation ||= /\brel\b/i.test(parameters);
      continue;
    }

    const relationValue = (relation[1] ?? relation[2]).trim();
    if (relationValue === "") {
      hasMalformedRelation = true;
      continue;
    }

    const rels = relationValue.split(/\s+/);
    if (rels.includes(relationName)) {
      if (
        expectedPathname != null &&
        !isExpectedGitHubApiUrl(match[1], expectedPathname)
      ) {
        return { status: "invalid" };
      }
      return { status: "valid", url: match[1] };
    }
  }

  return hasMalformedRelation ||
    new RegExp(`\\brel\\s*=\\s*"?[^",;]*\\b${relationName}\\b`, "i").test(
      linkHeader,
    )
    ? { status: "invalid" }
    : { status: "none" };
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
      isExpectedResourcePath(parsed.pathname, expectedPathname) &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

// GitHub writes pagination links as `/repositories/{id}/...` even when the
// request used `/repos/{owner}/{repo}/...`. Accept that form only for the same
// resource suffix; the id itself cannot be checked without another request.
function isExpectedResourcePath(
  pathname: string,
  expectedPathname: string,
): boolean {
  if (pathname === expectedPathname) return true;
  const expectedResource = /^\/repos\/[^/]+\/[^/]+(\/.+)$/.exec(
    expectedPathname,
  )?.[1];
  const linkedResource = /^\/repositories\/\d+(\/.+)$/.exec(pathname)?.[1];
  return expectedResource != null && linkedResource === expectedResource;
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

function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }

  return error instanceof Error && error.name === "AbortError";
}
