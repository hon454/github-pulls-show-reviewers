import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  assessListingBaseline,
  listingBaselineSchema,
  listingLocales,
  listingPaths,
} from "../scripts/release/listing.ts";
import { observeRelease } from "../scripts/release/status.ts";
import type { ListingBaseline } from "../scripts/release/listing.ts";

const target = {
  repository: "hon454/github-pulls-show-reviewers",
  publisherId: "publisher",
  itemId: "a".repeat(32),
  sourceSha: "a".repeat(40),
  version: "1.18.2",
};
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const now = Date.parse("2026-09-10T01:00:00.000Z");
// Test-only observations, never a production saved-listing assertion.
async function fixture(): Promise<ListingBaseline> {
  return {
    repository: target.repository,
    publisherId: target.publisherId,
    itemId: target.itemId,
    schemaVersion: 1,
    state: "verified",
    sourceSha: "b".repeat(40),
    locales: await Promise.all(
      listingLocales.map(async (locale) => {
        const paths = listingPaths(locale);
        return {
          locale,
          observedAt: "2026-09-01T00:00:00.000Z",
          evidenceUrl: `https://github.com/${target.repository}/issues/211#issuecomment-123`,
          savedAndReopened: true as const,
          descriptionSha256: hash(await readFile(paths.description)),
          imageSha256: (await Promise.all(
            paths.images.map(async (file) => hash(await readFile(file))),
          )) as [string, string, string],
        };
      }),
    ),
  };
}
async function input() {
  const raw = await fixture();
  return {
    raw,
    target,
    now,
    trustSource: vi.fn(),
    readSource: vi.fn(async (_sha: string, file: string) => readFile(file)),
  };
}

describe("reusable saved-listing evidence", () => {
  it("requires actual baseline evidence before treating local file equality as readiness", async () => {
    const x = await input();
    const report = await assessListingBaseline({ ...x, raw: undefined });
    expect(report).toEqual({ state: "missing" });
    expect(x.readSource).not.toHaveBeenCalled();
  });
  it("reuses all five saved locales across package versions without age-based dashboard refresh", async () => {
    const x = await input();
    const listing = await assessListingBaseline(x);
    expect(listing.state).toBe("unchanged");
    expect(listing.baseline?.locales).toHaveLength(5);
    expect(x.trustSource).toHaveBeenCalledExactlyOnceWith(x.raw.sourceSha);
    expect(x.readSource).toHaveBeenCalledTimes(40);
    const report = await observeRelease({
      target,
      workflowSha: "c".repeat(40),
      listing,
      store: {
        status: async () => ({
          name: `publishers/${target.publisherId}/items/${target.itemId}`,
          itemId: target.itemId,
        }),
      },
      history: async () => [],
      verifyPackage: async () => {
        throw new Error("No package download should be needed");
      },
    });
    expect(report.route).toBe("ordinary-release");
    expect(report.blockers).toEqual([]);
  });
  it.each(["description", "images"])(
    "routes a changed %s to staged listing work with the affected locale",
    async (kind) => {
      const x = await input();
      const paths = listingPaths("zh_TW");
      const changed =
        kind === "description" ? paths.description : paths.images[1];
      x.readSource.mockImplementation(async (sha, file) =>
        sha === target.sourceSha && file === changed
          ? kind === "description"
            ? Buffer.from(
                (await readFile(file, "utf8")).replace(
                  "<!-- description:start -->\n",
                  "<!-- description:start -->\nUpdated listing.\n",
                ),
              )
            : Buffer.from("changed")
          : readFile(file),
      );
      const report = await assessListingBaseline(x);
      expect(report.state).toBe("changed");
      expect(report.affectedLocales).toEqual(["zh_TW"]);
    },
  );
  it.each(listingLocales)(
    "ignores contributor-only edits outside the %s description",
    async (locale) => {
      const x = await input();
      x.readSource.mockImplementation(async (sha, file) => {
        const original = await readFile(file);
        return sha === target.sourceSha &&
          file === listingPaths(locale).description
          ? Buffer.concat([
              Buffer.from("Contributor note before the listing.\n"),
              original,
              Buffer.from("\nContributor note after the listing.\n"),
            ])
          : original;
      });
      const report = await assessListingBaseline(x);
      expect(report.state).toBe("unchanged");
      expect(report.affectedLocales).toEqual([]);
    },
  );
  it.each([" ", "\n"])(
    "detects description whitespace changes (%j)",
    async (whitespace) => {
      const x = await input();
      x.readSource.mockImplementation(async (sha, file) =>
        sha === target.sourceSha && file === listingPaths("en").description
          ? Buffer.from(
              (await readFile(file, "utf8")).replace(
                "<!-- description:end -->",
                `${whitespace}\n<!-- description:end -->`,
              ),
            )
          : readFile(file),
      );
      expect(await assessListingBaseline(x)).toMatchObject({
        state: "changed",
        affectedLocales: ["en"],
      });
    },
  );
  it.each(["missing", "duplicate", "reversed", "empty"])(
    "rejects %s description markers even when baseline hashes match",
    async (kind) => {
      const x = await input();
      const start = "<!-- description:start -->";
      const end = "<!-- description:end -->";
      const malformed = Buffer.from(
        kind === "missing"
          ? "No description markers"
          : kind === "duplicate"
            ? `${start}\nText\n${end}\n${start}\nOther\n${end}`
            : kind === "reversed"
              ? `${end}\nText\n${start}`
              : `${start}\n \n${end}`,
      );
      x.raw.locales[0].descriptionSha256 = hash(malformed);
      x.readSource.mockImplementation(async (_sha, file) =>
        file === listingPaths("en").description ? malformed : readFile(file),
      );
      expect(await assessListingBaseline(x)).toEqual({ state: "conflicting" });
    },
  );
  it("rejects missing, duplicated, wrong-item, invalidated, forged or credential-bearing evidence", async () => {
    const x = await input();
    const bad = [
      {},
      { ...x.raw, state: "invalidated" },
      { ...x.raw, itemId: "b".repeat(32) },
      { ...x.raw, locales: x.raw.locales.slice(1) },
      { ...x.raw, locales: [x.raw.locales[0], ...x.raw.locales.slice(0, 4)] },
      ...[
        { savedAndReopened: false },
        { observedAt: "2099-01-01T00:00:00.000Z" },
        { descriptionSha256: "f".repeat(64) },
        { imageSha256: [...x.raw.locales[0].imageSha256].reverse() },
        {
          evidenceUrl: `https://github.com/${target.repository}/issues/211?token=secret#issuecomment-123`,
        },
        {
          evidenceUrl:
            "https://github.com/another/repository/issues/1#issuecomment-123",
        },
        {
          evidenceUrl: `https://secret@github.com/${target.repository}/issues/211#issuecomment-123`,
        },
        { evidenceUrl: `https://github.com/${target.repository}/issues/211` },
      ].map((change) => ({
        ...x.raw,
        locales: [
          { ...x.raw.locales[0], ...change },
          ...x.raw.locales.slice(1),
        ],
      })),
    ];
    for (const raw of bad)
      expect(await assessListingBaseline({ ...x, raw })).toEqual({
        state: "conflicting",
      });
    expect(
      listingBaselineSchema.safeParse({ ...x.raw, token: "secret" }).success,
    ).toBe(false);
  });
  it("does not reuse an untrusted baseline source or unreadable historical files", async () => {
    const x = await input();
    x.trustSource.mockImplementation(() => {
      throw new Error("untrusted");
    });
    expect(await assessListingBaseline(x)).toEqual({ state: "conflicting" });
    x.trustSource.mockReset();
    x.readSource.mockRejectedValue(new Error("secret-error"));
    expect(await assessListingBaseline(x)).toEqual({ state: "conflicting" });
  });
});
