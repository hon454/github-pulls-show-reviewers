import type { Catalog } from "./messages";

/** Build/test validation. Not imported by extension entrypoints. */
export function validateCatalogs(catalogs: Record<string, Catalog>): string[] {
  const errors: string[] = [];
  const english = catalogs.en ?? {};
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
