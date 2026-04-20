import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const sourceSvg = path.join(projectRoot, "icon", "source.svg");
const outputDir = path.join(projectRoot, "public", "icon");
const sizes = [16, 32, 48, 128];
const svgMarkup = await readFile(sourceSvg, "utf8");

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await mkdir(outputDir, { recursive: true });

  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`
      <style>
        html, body {
          margin: 0;
          padding: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: transparent;
        }

        svg {
          display: block;
          width: 100%;
          height: 100%;
        }
      </style>
      ${svgMarkup}
    `);

    await page.locator("svg").screenshot({
      path: path.join(outputDir, `${size}.png`),
    });
  }
} finally {
  await browser.close();
}
