import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { catalogs } from "../src/i18n/catalogs";

const keys = Object.keys(catalogs.en);

function sourceFiles(entry: string): string[] {
  if (statSync(entry).isFile()) return [entry];
  return readdirSync(entry).flatMap((name) => {
    const child = path.join(entry, name);
    if (statSync(child).isDirectory()) return sourceFiles(child);
    return /\.(?:ts|tsx|mjs|js|html)$/.test(name) ? [child] : [];
  });
}

const consumerSource = ["src", "entrypoints", "scripts", "wxt.config.ts"]
  .flatMap((entry) => sourceFiles(path.resolve(entry)))
  .filter((file) => !file.endsWith(path.join("src", "i18n", "messages.ts")))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

// The access banner builds these keys from a literal prefix plus a
// reset-time suffix (src/features/access-banner/aggregator.ts).
const DYNAMIC_KEY =
  /^(banner_(?:auth|unauth)_rate)_(?:unknown|shortly|minutes?|hours?)$/;

function hasConsumer(key: string): boolean {
  const literal = new RegExp(`["'\`]${key}["'\`]|__MSG_${key}__`);
  if (literal.test(consumerSource)) return true;
  const dynamic = DYNAMIC_KEY.exec(key);
  return dynamic !== null && consumerSource.includes(`"${dynamic[1]}"`);
}

describe("i18n catalog drift", () => {
  it("gives every message key a consumer", () => {
    expect(keys.filter((key) => !hasConsumer(key))).toEqual([]);
  });

  it("keeps the documented namespace table in step with the catalog", () => {
    const doc = readFileSync(path.resolve("docs/localization.md"), "utf8");
    const documented = Object.fromEntries(
      [...doc.matchAll(/^\| `([a-z]+)_`\s+\|\s+(\d+) \|/gm)].map((row) => [
        row[1],
        Number(row[2]),
      ]),
    );
    const actual: Record<string, number> = {};
    for (const key of keys) {
      const namespace = key.split("_")[0]!;
      actual[namespace] = (actual[namespace] ?? 0) + 1;
    }
    expect(documented).toEqual(actual);
    expect(doc).toContain(
      `The catalog currently has ${keys.length} keys per locale.`,
    );
  });
});
