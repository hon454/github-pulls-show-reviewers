import type { AccountSummary as Account } from "../../runtime/ui-contract";

export type ReviewerFailure = {
  readonly account: Pick<Account, "id"> | null;
  readonly error: unknown;
};

export type ReviewerOutcome =
  | { readonly status: "pending" }
  | { readonly status: "success" }
  | { readonly status: "failure"; readonly failure: ReviewerFailure };

export type ReviewerRowOutcome = {
  // Duplicate DOM rows share the same PR data request and result.
  readonly pullNumber: string;
  readonly request: object | null;
  readonly outcome: ReviewerOutcome;
};

export type ReviewerOutcomeSnapshot = {
  readonly generation: number;
  readonly pathname: string;
  readonly rows: readonly ReviewerRowOutcome[];
};

/** Data outcomes only: this coordinator never fetches, renders or schedules. */
export function createReviewerOutcomeCoordinator(
  onChange: (snapshot: ReviewerOutcomeSnapshot) => void,
) {
  let generation = -1;
  let pathname = "";
  const rows = new Map<string, ReviewerRowOutcome>();
  let publicationQueued = false;

  function emit(): void {
    if (publicationQueued) return;
    publicationQueued = true;
    queueMicrotask(() => {
      publicationQueued = false;
      onChange({ generation, pathname, rows: [...rows.values()] });
    });
  }

  function pending(pullNumber: string): ReviewerRowOutcome {
    return { pullNumber, request: null, outcome: { status: "pending" } };
  }

  return {
    reset(next: {
      generation: number;
      pathname: string;
      pullNumbers: readonly string[];
    }): void {
      generation = next.generation;
      pathname = next.pathname;
      rows.clear();
      next.pullNumbers.forEach((number) => rows.set(number, pending(number)));
      // Register the entire visible set before any cache hit can settle.
      emit();
    },
    reconcile(pullNumbers: readonly string[]): void {
      const visible = new Set(pullNumbers);
      let changed = false;
      for (const number of rows.keys()) {
        if (!visible.has(number)) {
          rows.delete(number);
          changed = true;
        }
      }
      for (const number of visible) {
        if (!rows.has(number)) {
          rows.set(number, pending(number));
          changed = true;
        }
      }
      if (changed) emit();
    },
    begin(epoch: number, pullNumber: string, request: object): void {
      const row = rows.get(pullNumber);
      if (epoch !== generation || row == null || row.request === request)
        return;
      rows.set(pullNumber, {
        pullNumber,
        request,
        outcome: { status: "pending" },
      });
      emit();
    },
    pending(epoch: number, pullNumber: string): void {
      const row = rows.get(pullNumber);
      if (
        epoch !== generation ||
        row == null ||
        row.outcome.status === "pending"
      )
        return;
      rows.set(pullNumber, pending(pullNumber));
      emit();
    },
    cached(epoch: number, pullNumber: string): void {
      const row = rows.get(pullNumber);
      if (
        epoch !== generation ||
        row == null ||
        row.request != null ||
        row.outcome.status !== "pending"
      )
        return;
      rows.set(pullNumber, { ...row, outcome: { status: "success" } });
      emit();
    },
    settle(
      epoch: number,
      pullNumber: string,
      request: object,
      outcome: Exclude<ReviewerOutcome, { status: "pending" }>,
    ): void {
      const row = rows.get(pullNumber);
      if (
        epoch !== generation ||
        row == null ||
        row.request !== request ||
        row.outcome.status !== "pending"
      )
        return;
      // Preserve completion order for equal-priority failure snapshots.
      rows.delete(pullNumber);
      rows.set(pullNumber, { ...row, outcome });
      emit();
    },
  };
}
