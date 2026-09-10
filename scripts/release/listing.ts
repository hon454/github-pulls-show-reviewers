import { createHash } from "node:crypto";
import { z } from "zod";
import { extractCwsDescription } from "../cws-description.mjs";
import { hashSchema, parse, requireCondition, shaSchema } from "./policy.ts";
import type { ReleaseTarget } from "./readiness.ts";

export const listingLocales = ["en", "ko", "ja", "zh_CN", "zh_TW"] as const;
export const listingBaselinePath =
  "docs/chrome-web-store-listing-baseline.json";
const localeSchema = z.enum(listingLocales);
const imageNames = [
  "01-pr-list-before-after.png",
  "02-pr-list-avatar-state-showcase.png",
  "03-options-repository-check.png",
];
export function listingPaths(locale: (typeof listingLocales)[number]) {
  return {
    description: `docs/chrome-web-store-locales/${locale}.md`,
    images: imageNames.map(
      (name) =>
        `docs/chrome-web-store-assets/${locale === "en" ? "" : `${locale}/`}${name}`,
    ),
  };
}
const permalinkSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    ((/^\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(url.pathname) &&
      /^#issuecomment-\d+$/.test(url.hash)) ||
      (/^\/[\w.-]+\/[\w.-]+\/commit\/[a-f0-9]{40}$/.test(url.pathname) &&
        !url.hash))
  );
});
const localeEvidenceSchema = z.strictObject({
  locale: localeSchema,
  observedAt: z.iso.datetime(),
  evidenceUrl: permalinkSchema,
  savedAndReopened: z.literal(true),
  descriptionSha256: hashSchema,
  imageSha256: z.tuple([hashSchema, hashSchema, hashSchema]),
});
export const listingBaselineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.enum(["verified", "invalidated"]),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  publisherId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  itemId: z.string().regex(/^[a-p]{32}$/),
  sourceSha: shaSchema,
  locales: z.array(localeEvidenceSchema).length(5),
});
export type ListingBaseline = z.infer<typeof listingBaselineSchema>;
export const listingAssessmentSchema = z.strictObject({
  state: z.enum(["unchanged", "changed", "missing", "conflicting"]),
  baseline: listingBaselineSchema
    .pick({ sourceSha: true, locales: true })
    .optional(),
  affectedLocales: z.array(localeSchema).optional(),
});
export type ListingAssessment = z.infer<typeof listingAssessmentSchema>;

// The caller supplies reviewed evidence and Git reads, never browser state or arbitrary paths.
// Hash equality validates the association with an operator's saved-content evidence;
// it cannot establish that the dashboard was saved or that remote bytes have this digest.
export async function assessListingBaseline(input: {
  raw: unknown;
  target: ReleaseTarget;
  readSource: (sha: string, file: string) => Promise<Buffer>;
  trustSource: (sha: string) => void;
  now?: number;
}): Promise<ListingAssessment> {
  if (input.raw === undefined) return { state: "missing" };
  try {
    const baseline = parse(
      listingBaselineSchema,
      input.raw,
      "saved-listing baseline",
    );
    requireCondition(
      baseline.state === "verified",
      "Saved-listing baseline is invalidated.",
    );
    for (const key of ["repository", "publisherId", "itemId"] as const)
      requireCondition(
        baseline[key] === input.target[key],
        "Saved-listing identity mismatch.",
      );
    requireCondition(
      [...baseline.locales.map((l) => l.locale)].sort().join(",") ===
        [...listingLocales].sort().join(","),
      "Exactly five unique listing locales are required.",
    );
    input.trustSource(baseline.sourceSha);
    const changed: (typeof listingLocales)[number][] = [];
    for (const locale of baseline.locales) {
      requireCondition(
        Date.parse(locale.observedAt) <= (input.now ?? Date.now()),
        "Saved-content evidence cannot be from the future.",
      );
      requireCondition(
        new URL(locale.evidenceUrl).pathname.startsWith(
          `/${input.target.repository}/`,
        ),
        "Saved-content evidence belongs to a different repository.",
      );
      const paths = listingPaths(locale.locale);
      const files = [paths.description, ...paths.images];
      const hashes = [locale.descriptionSha256, ...locale.imageSha256];
      let differs = false;
      for (let i = 0; i < files.length; i++) {
        const atBaseline = await input.readSource(
          baseline.sourceSha,
          files[i]!,
        );
        requireCondition(
          digest(atBaseline) === hashes[i],
          "Baseline hashes differ from its reviewed source.",
        );
        const atTarget = await input.readSource(
          input.target.sourceSha,
          files[i]!,
        );
        // The saved whole-file hash proves source provenance. Only submitted
        // description text and ordered images determine actual listing work.
        if (i === 0) {
          if (
            extractCwsDescription(atTarget.toString("utf8")) !==
            extractCwsDescription(atBaseline.toString("utf8"))
          )
            differs = true;
        } else if (digest(atTarget) !== hashes[i]) differs = true;
      }
      if (differs) changed.push(locale.locale);
    }
    return {
      state: changed.length ? "changed" : "unchanged",
      baseline: { sourceSha: baseline.sourceSha, locales: baseline.locales },
      affectedLocales: changed,
    };
  } catch {
    // Invalid evidence may contain credentials or arbitrary attacker text; never echo it.
    return { state: "conflicting" };
  }
}
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
