import { z } from "zod";

const avatarUrlField = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Avatar URL must be http(s)")
  .nullable()
  .optional()
  .catch(null);

const userLiteSchema = z.object({
  login: z.string(),
  avatar_url: avatarUrlField,
});

export const pullSchema = z.object({
  // GitHub documents the author as nullable (for example a removed account).
  user: z
    .object({
      login: z.string(),
    })
    .nullable(),
  requested_reviewers: z.array(userLiteSchema).default([]),
  requested_teams: z
    .array(
      z.object({
        slug: z.string(),
      }),
    )
    .default([]),
});

const pullReviewerMetadataSchema = pullSchema.extend({
  number: z.number(),
});

const pullNumberSchema = z.object({
  number: z.number(),
});

/**
 * Parses a pull-list page item by item. One pull that fails validation must
 * not fail its neighbours: it is kept as `{ number, malformed }` so pagination
 * still knows the pull was seen, and dropped entirely when it has no number.
 */
export const pullReviewerMetadataListSchema = z
  .array(z.unknown())
  .transform((items) =>
    items.flatMap((item): GitHubPullReviewerMetadataItem[] => {
      const parsed = pullReviewerMetadataSchema.safeParse(item);
      if (parsed.success) return [parsed.data];
      const numbered = pullNumberSchema.safeParse(item);
      return numbered.success
        ? [{ number: numbered.data.number, malformed: true }]
        : [];
    }),
  );

export const pullListSchema = z.array(pullNumberSchema);

export const reviewsSchema = z.array(
  z.object({
    state: z.string(),
    submitted_at: z.string().nullable().optional(),
    user: userLiteSchema.nullable(),
  }),
);

export const reviewRequestEventsSchema = z.array(
  z.object({
    event: z.string(),
    created_at: z.string(),
    requested_reviewer: userLiteSchema.nullable().optional(),
  }),
);

export const rateLimitSchema = z.object({
  rate: z.object({
    limit: z.number(),
    remaining: z.number(),
  }),
});

export const errorResponseSchema = z
  .object({
    message: z.string().optional(),
  })
  .passthrough();

export type GitHubPull = z.infer<typeof pullSchema>;
export type GitHubPullReviewerMetadata = z.infer<
  typeof pullReviewerMetadataSchema
>;
export type GitHubPullReviewerMetadataItem =
  GitHubPullReviewerMetadata | { number: number; malformed: true };
export type GitHubReview = z.infer<typeof reviewsSchema>[number];
export type GitHubReviewRequestEvent = z.infer<
  typeof reviewRequestEventsSchema
>[number];

export function normalizeAvatarUrl(
  raw: string | null | undefined,
): string | null {
  return raw ?? null;
}
