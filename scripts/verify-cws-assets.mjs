#!/usr/bin/env node
/* global console, process */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const locales = ["en", "ko", "ja", "zh_CN", "zh_TW"];
export const sceneFiles = [
  "01-pr-list-before-after.png",
  "02-pr-list-avatar-state-showcase.png",
  "03-options-repository-check.png",
];
export const assetPaths = locales.flatMap((locale) =>
  sceneFiles.map(
    (file) =>
      `docs/chrome-web-store-assets/${locale === "en" ? "" : `${locale}/`}${file}`,
  ),
);
export const sourcePaths = [
  "tests/e2e/capture-cws-assets.spec.ts",
  "tests/fixtures/github-pulls.html",
  "pnpm-lock.yaml",
  "package.json",
  "wxt.config.ts",
  "scripts/verify-cws-assets.mjs",
  ...["src", "entrypoints", "public/icon"].flatMap((directory) =>
    readdirSync(path.join(root, directory), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(root, path.join(entry.parentPath, entry.name)),
      )
      .sort(),
  ),
  ...locales.flatMap((locale) => [
    `public/_locales/${locale}/messages.json`,
    `docs/chrome-web-store-locales/${locale}.md`,
  ]),
];
export function fileHashes(paths) {
  return Object.fromEntries(
    paths.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
}

export function verifyCwsAssets() {
  const reports = [];
  const listingRoot = path.join(root, "docs/chrome-web-store-locales");
  assert.deepEqual(
    readdirSync(listingRoot)
      .filter((file) => file.endsWith(".md"))
      .sort(),
    locales.map((locale) => `${locale}.md`).sort(),
  );
  for (const locale of locales) {
    const catalogPath = `public/_locales/${locale}/messages.json`;
    const catalog = JSON.parse(
      readFileSync(path.join(root, catalogPath), "utf8"),
    );
    const name = catalog.extension_name.message;
    const summary = catalog.extension_description.message;
    assert.equal(
      name,
      "GitHub Pulls Show Reviewers",
      `${locale}: canonical brand`,
    );
    assert.ok(
      name.length <= 75 && summary.trim().length > 0 && summary.length <= 132,
      `${locale}: metadata limits`,
    );
    if (locale === "en") {
      assert.ok(
        readFileSync(path.join(root, "README.md"), "utf8").includes(
          `> ${summary}\n`,
        ),
        "README tagline must mirror the canonical English summary",
      );
    }
    const listingPath = path.join(listingRoot, `${locale}.md`);
    const copy = readFileSync(listingPath, "utf8");
    assert.ok(
      copy.includes(`Name: \`${name}\``),
      `${locale}: listing brand matches catalog`,
    );
    assert.ok(
      copy.includes(
        `Short description source: [\`extension_description.message\`](../../${catalogPath}).`,
      ),
      `${locale}: linked canonical summary`,
    );
    assert.ok(
      !copy.includes(summary),
      `${locale}: do not maintain a duplicate summary`,
    );
    const description = copy.match(
      /<!-- description:start -->\n([\s\S]+?)\n<!-- description:end -->/,
    )?.[1];
    assert.ok(
      description?.trim(),
      `${locale}: ready-to-paste detailed description`,
    );
    assert.ok(
      description.length <= 16000,
      `${locale}: detailed description limit`,
    );
    for (const caption of ["before", "after"]) {
      assert.equal(
        [...copy.matchAll(new RegExp(`<!-- capture-${caption}: (.+) -->`, "g"))]
          .length,
        1,
        `${locale}: one reviewed ${caption} caption`,
      );
    }
    const images = [...copy.matchAll(/\]\(([^)]+\.png)\)/g)].map((match) =>
      path.relative(root, path.resolve(path.dirname(listingPath), match[1])),
    );
    assert.deepEqual(
      images,
      assetPaths.filter((file) =>
        locale === "en"
          ? path.dirname(file) === "docs/chrome-web-store-assets"
          : file.includes(`/${locale}/`),
      ),
      `${locale}: screenshot order and locale`,
    );
    reports.push({
      locale,
      name,
      nameLength: name.length,
      summary,
      summaryLength: summary.length,
    });
  }
  // Check relative documentation/image/catalog links in every changed listing surface.
  for (const file of [
    "README.md",
    "docs/chrome-web-store.md",
    "docs/chrome-web-store-submission.md",
    ...locales.map((locale) => `docs/chrome-web-store-locales/${locale}.md`),
  ]) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(
        existsSync(path.resolve(root, path.dirname(file), target)),
        `${file}: missing link ${target}`,
      );
    }
  }
  for (const file of assetPaths) {
    const png = readFileSync(path.join(root, file));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file);
    assert.equal(png.toString("ascii", 12, 16), "IHDR", file);
    assert.equal(png.readUInt32BE(16), 1280, `${file}: width`);
    assert.equal(png.readUInt32BE(20), 800, `${file}: height`);
    assert.equal(png[24], 8, `${file}: bit depth`);
    assert.equal(png[25], 2, `${file}: RGB without alpha`);
  }
  const manifest = JSON.parse(
    readFileSync(
      path.join(root, "docs/chrome-web-store-assets/capture-manifest.json"),
      "utf8",
    ),
  );
  assert.equal(
    manifest.build,
    "TESTING GitHub App; synthetic fixtures; not production-config evidence",
  );
  assert.deepEqual(
    manifest.sources,
    fileHashes(sourcePaths),
    "Capture sources changed: rerun pnpm cws:assets",
  );
  assert.deepEqual(
    manifest.images,
    fileHashes(assetPaths),
    "Capture image hashes differ",
  );
  return reports;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(JSON.stringify(verifyCwsAssets(), null, 2));
  console.log(
    "Verified five source-linked listings, 15 RGB 1280x800 PNGs, links, order and capture provenance.",
  );
}
