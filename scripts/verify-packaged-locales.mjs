#!/usr/bin/env node
/* global console, process */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";

const output = process.argv[2] ?? ".output/chrome-mv3";
const expected = ["en", "ja", "ko", "zh_CN", "zh_TW"];
const localeRoot = path.join(output, "_locales");
const actual = readdirSync(localeRoot).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `Expected exactly five locale directories; found ${actual.join(", ")}`,
  );
}
const manifest = JSON.parse(
  readFileSync(path.join(output, "manifest.json"), "utf8"),
);
if (manifest.default_locale !== "en")
  throw new Error("default_locale must be en");
for (const [field, value] of Object.entries({
  name: manifest.name,
  description: manifest.description,
  default_title: manifest.action?.default_title,
})) {
  if (typeof value !== "string" || !/^__MSG_\w+__$/.test(value))
    throw new Error(`${field} must use a message reference`);
}
const references = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map(
  (match) => match[1],
);
for (const locale of expected) {
  const messages = JSON.parse(
    readFileSync(path.join(localeRoot, locale, "messages.json"), "utf8"),
  );
  const source = JSON.parse(
    readFileSync(
      new URL(`../public/_locales/${locale}/messages.json`, import.meta.url),
      "utf8",
    ),
  );
  if (JSON.stringify(messages) !== JSON.stringify(source))
    throw new Error(`${locale}: emitted catalog differs from source`);
  for (const key of references) {
    if (!messages[key]?.message?.trim())
      throw new Error(`${locale}: unresolved manifest message ${key}`);
  }
  const name = messages[manifest.name.slice(6, -2)].message;
  const description = messages[manifest.description.slice(6, -2)].message;
  if (name !== "GitHub Pulls Show Reviewers" || name.length > 75)
    throw new Error(`${locale}: invalid product name`);
  if (description.length > 132)
    throw new Error(`${locale}: description exceeds 132 characters`);
}
console.log(
  `Verified five packaged locales and all manifest references in ${output}`,
);
