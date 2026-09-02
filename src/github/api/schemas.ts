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
  user: z.object({
    login: z.string(),
  }),
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

export const pullReviewerMetadataListSchema = z.array(
  pullReviewerMetadataSchema,
);

export const pullListSchema = z.array(
  z.object({
    number: z.number(),
  }),
);

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
export type GitHubReview = z.infer<typeof reviewsSchema>[number];
export type GitHubReviewRequestEvent = z.infer<
  typeof reviewRequestEventsSchema
>[number];

export function normalizeAvatarUrl(
  raw: string | null | undefined,
): string | null {
  return raw ?? null;
}
