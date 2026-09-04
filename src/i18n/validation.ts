import { z } from "zod";

// Deliberately stricter than Chrome: this project's context and named-argument
// contract are required even where Chrome accepts optional/direct substitutions.
const catalogSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]*$/),
  z.strictObject({
    message: z.string(),
    description: z.string(),
    placeholders: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]*$/),
        z.strictObject({
          content: z.string(),
          example: z.string().optional(),
        }),
      )
      .optional(),
  }),
);

/** Build/test validation. Not imported by extension entrypoints. */
export function validateCatalogs(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const catalogs: Record<string, z.infer<typeof catalogSchema>> = {};
  for (const [locale, value] of Object.entries(input)) {
    const parsed = catalogSchema.safeParse(value);
    if (!parsed.success) {
      errors.push(
        `${locale}: invalid Chrome catalog format (${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")})`,
      );
    } else catalogs[locale] = parsed.data;
  }
  const english = catalogs.en ?? {};
  if (!Object.keys(english).length)
    errors.push("en: complete nonempty fallback catalog required");
  const keys = Object.keys(english).sort();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    if (JSON.stringify(Object.keys(catalog).sort()) !== JSON.stringify(keys)) {
      errors.push(`${locale}: keys differ from English`);
    }
    for (const [key, entry] of Object.entries(catalog)) {
      const context = `${locale}.${key}`;
      if (
        !/^(extension|language|options|auth|diagnostics|reviewers|banner)_/.test(
          key,
        )
      )
        errors.push(`${context}: unreserved namespace`);
      if (!entry.message.trim() || !entry.description.trim())
        errors.push(`${context}: empty translation or description`);
      if (
        entry.message
          .replaceAll("$$", "")
          .replace(/\$[a-zA-Z0-9_]+\$/g, "")
          .includes("$")
      )
        errors.push(
          `${context}: malformed dollar placeholder; use $$ for a literal dollar`,
        );
      const placeholders = entry.placeholders ?? {};
      const contract = (value: typeof placeholders) =>
        Object.entries(value)
          .map(
            ([name, definition]) =>
              `${name.toLowerCase()}:${definition.content}`,
          )
          .sort();
      if (
        JSON.stringify(contract(placeholders)) !==
        JSON.stringify(contract(english[key]?.placeholders ?? {}))
      )
        errors.push(`${context}: placeholder contract differs from English`);
      const names = Object.keys(placeholders)
        .map((name) => name.toLowerCase())
        .sort();
      if (names.length > 9)
        errors.push(`${context}: Chrome supports at most nine substitutions`);
      const tokens = [
        ...entry.message.replaceAll("$$", "").matchAll(/\$([a-zA-Z0-9_]+)\$/g),
      ].map((match) => match[1].toLowerCase());
      if (JSON.stringify([...new Set(tokens)].sort()) !== JSON.stringify(names))
        errors.push(
          `${context}: message placeholders do not match declarations`,
        );
      const positions = Object.values(placeholders)
        .map(({ content }) => content)
        .sort();
      if (
        JSON.stringify(positions) !==
        JSON.stringify(names.map((_, index) => `$${index + 1}`).sort())
      )
        errors.push(
          `${context}: placeholders must have unique contiguous positional contents`,
        );
    }
  }
  return errors;
}

/** Shipping requires every locale; fallback must never hide missing translations. */
export function validateShippedCatalogs(
  catalogs: Record<string, unknown>,
): string[] {
  const errors = validateCatalogs(catalogs);
  if (
    JSON.stringify(Object.keys(catalogs).sort()) !==
    JSON.stringify(["en", "ja", "ko", "zh_CN", "zh_TW"])
  )
    errors.push("Expected exactly en, ja, ko, zh_CN, zh_TW catalogs");
  const english = catalogSchema.safeParse(catalogs.en);
  // Brands, language autonyms and identifier-only patterns are intentionally shared.
  const invariant = new Set([
    "extension_name",
    "language_en",
    "language_ko",
    "language_ja",
    "language_zh_cn",
    "language_zh_tw",
    "reviewers_title",
    "reviewers_aria",
  ]);
  if (english.success) {
    for (const [locale, value] of Object.entries(catalogs)) {
      const parsed = catalogSchema.safeParse(value);
      if (locale === "en" || !parsed.success) continue;
      for (const [key, entry] of Object.entries(parsed.data)) {
        if (!invariant.has(key) && entry.message === english.data[key]?.message)
          errors.push(`${locale}.${key}: untranslated English message`);
      }
    }
  }
  return errors;
}
