// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { buildReviewerCacheKey } from "../src/cache/reviewer-cache";
import { createReviewerRequestRegistry } from "../src/features/reviewers/request-registry";

const key = buildReviewerCacheKey("octo", "repo", "42");
const otherKey = buildReviewerCacheKey("octo", "repo", "43");
const mount = () => document.createElement("span");

describe("reviewer request registry", () => {
  it("tracks one in-flight request and its owner identity per pull request", () => {
    const registry = createReviewerRequestRegistry();
    expect(registry.get(key)).toBeUndefined();
    expect(registry.ownerOf(key)).toBeUndefined();

    const request = registry.start(key, mount(), () => true);

    expect(registry.get(key)).toBe(request);
    expect(registry.ownerOf(key)).toBe(request.owner);
    expect(registry.get(otherKey)).toBeUndefined();
    expect(request.invalidated).toBe(false);
    expect(request.succeeded).toBe(false);
  });

  it("keeps the last owner identity after release to reject delayed renders", () => {
    const registry = createReviewerRequestRegistry();
    const first = registry.start(key, mount(), () => true);

    expect(registry.release(key, first)).toBe(true);

    expect(registry.get(key)).toBeUndefined();
    expect(registry.ownerOf(key)).toBe(first.owner);
    const second = registry.start(key, mount(), () => true);
    expect(second.owner).not.toBe(first.owner);
    expect(registry.ownerOf(key)).toBe(second.owner);
  });

  it("releases only the request that is still registered", () => {
    const registry = createReviewerRequestRegistry();
    const first = registry.start(key, mount(), () => true);
    registry.release(key, first);
    const second = registry.start(key, mount(), () => true);

    expect(registry.release(key, first)).toBe(false);

    expect(registry.get(key)).toBe(second);
  });

  it("is current while registered, not aborted and wanted by a live consumer", () => {
    const registry = createReviewerRequestRegistry();
    let ownerRowLive = true;
    const request = registry.start(key, mount(), () => ownerRowLive);
    expect(registry.isCurrent(key, request)).toBe(true);

    // The data belongs to live rows: a replacement row keeps the request.
    ownerRowLive = false;
    expect(registry.isCurrent(key, request)).toBe(false);
    registry.join(request, mount(), () => true);
    expect(registry.isCurrent(key, request)).toBe(true);

    request.controller.abort();
    expect(registry.isCurrent(key, request)).toBe(false);
  });

  it("is not current once another request replaced it", () => {
    const registry = createReviewerRequestRegistry();
    const first = registry.start(key, mount(), () => true);
    registry.release(key, first);
    registry.start(key, mount(), () => true);

    expect(registry.isCurrent(key, first)).toBe(false);
  });

  it("marks only an in-flight request as invalidated", () => {
    const registry = createReviewerRequestRegistry();
    registry.invalidate(key);
    const request = registry.start(key, mount(), () => true);
    expect(request.invalidated).toBe(false);

    registry.invalidate(key);
    expect(request.invalidated).toBe(true);
  });

  it("lists the live consumers of a request", () => {
    const registry = createReviewerRequestRegistry();
    const live = mount();
    const gone = mount();
    const request = registry.start(key, gone, () => false);
    registry.join(request, live, () => true);

    expect(registry.liveConsumers(request)).toEqual([live]);
  });

  it("aborts every request and forgets all identities", () => {
    const registry = createReviewerRequestRegistry();
    const first = registry.start(key, mount(), () => true);
    const second = registry.start(otherKey, mount(), () => true);

    registry.abortAll();

    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
    expect(registry.get(key)).toBeUndefined();
    expect(registry.ownerOf(key)).toBeUndefined();
    expect(registry.ownerOf(otherKey)).toBeUndefined();
  });
});
