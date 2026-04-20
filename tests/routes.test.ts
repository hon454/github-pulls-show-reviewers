import { describe, expect, it } from "vitest";

import { parsePullListRoute } from "../src/github/routes";

describe("parsePullListRoute", () => {
  it("parses a standard pull list route", () => {
    expect(parsePullListRoute("/octocat/hello-world/pulls")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("accepts routes with trailing slash", () => {
    expect(parsePullListRoute("/octocat/hello-world/pulls/")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("returns null for non-pull-list routes", () => {
    expect(parsePullListRoute("/octocat/hello-world/issues")).toBeNull();
  });
});
