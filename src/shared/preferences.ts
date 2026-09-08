import { z } from "zod";
import { SUPPORTED_LOCALES } from "../i18n/locale";

export const preferencesSchema = z.object({
  version: z.literal(1),
  language: z.enum(["auto", ...SUPPORTED_LOCALES]).catch("auto"),
  showStateBadge: z.boolean(),
  showReviewerName: z.boolean(),
  openPullsOnly: z.boolean().default(true),
});

/** Writes reject unknown/invalid fields; repair defaults apply only to reads. */
export const preferencePatchSchema = z.strictObject({
  language: z.enum(["auto", ...SUPPORTED_LOCALES]).optional(),
  showStateBadge: z.boolean().optional(),
  showReviewerName: z.boolean().optional(),
  openPullsOnly: z.boolean().optional(),
});

export type Preferences = z.infer<typeof preferencesSchema>;
export type PreferencePatch = z.infer<typeof preferencePatchSchema>;
export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  language: "auto",
  showStateBadge: true,
  showReviewerName: false,
  openPullsOnly: true,
};

export function parsePreferences(value: unknown): Preferences {
  const parsed = preferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_PREFERENCES };
}
