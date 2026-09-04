export const locales: string[];
export const sceneFiles: string[];
export const assetPaths: string[];
export const sourcePaths: string[];
export function fileHashes(paths: string[]): Record<string, string>;
export function verifyCwsAssets(): Array<{
  locale: string;
  name: string;
  nameLength: number;
  summary: string;
  summaryLength: number;
}>;
