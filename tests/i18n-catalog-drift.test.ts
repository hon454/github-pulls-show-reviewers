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

// Superseded variants of glossary terms (docs/localization.md). Each entry
// lists the locale's catalog and README so both stay on the glossary term.
const SUPERSEDED: Record<
  Exclude<keyof typeof catalogs, "en">,
  { readme: string; terms: string[] }
> = {
  ko: { readme: "README.ko.md", terms: ["레이트 제한", "미인증", "재설정"] },
  ja: { readme: "README.ja.md", terms: ["サインイン", "未完了"] },
  zh_CN: { readme: "README.zh-CN.md", terms: ["未认证"] },
  zh_TW: { readme: "README.zh-TW.md", terms: ["未驗證", "請求"] },
};

describe("i18n glossary regressions", () => {
  it.each(Object.entries(SUPERSEDED))(
    "keeps %s on the glossary terms",
    (locale, { readme, terms }) => {
      const catalog = catalogs[locale as keyof typeof SUPERSEDED];
      const text = [
        ...Object.values(catalog).map((entry) => entry.message),
        readFileSync(path.resolve(readme), "utf8"),
      ].join("\n");
      expect(terms.filter((term) => text.includes(term))).toEqual([]);
    },
  );

  it("uses one ellipsis and no space after a full-width full stop", () => {
    const offending = Object.entries(catalogs).flatMap(([locale, catalog]) =>
      Object.entries(catalog)
        .filter(([, entry]) => /\.\.\.|。 /.test(entry.message))
        .map(([key]) => `${locale}.${key}`),
    );
    expect(offending).toEqual([]);
  });
});
