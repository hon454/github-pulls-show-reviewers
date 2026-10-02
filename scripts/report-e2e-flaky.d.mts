export interface FlakyTest {
  file: string;
  line: number;
  title: string;
  project: string;
  attempts: string[];
}
export function collectFlaky(report: unknown): FlakyTest[];
export function summarize(flaky: FlakyTest[]): string;
