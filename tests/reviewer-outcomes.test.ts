import { describe, expect, it, vi } from "vitest";

import { createReviewerOutcomeCoordinator } from "../src/features/reviewers/outcomes";

const initial = {
  generation: 0,
  pathname: "/o/r/pulls",
  pullNumbers: ["1", "2"],
};
const failure = {
  status: "failure" as const,
  failure: { account: null, error: new Error("offline") },
};

describe("reviewer outcome ownership", () => {
  it("registers the complete visible set, including cache-only and queued work, in one publication", async () => {
    const publish = vi.fn();
    const outcomes = createReviewerOutcomeCoordinator(publish);
    outcomes.reset({ ...initial, pullNumbers: ["1", "2", "3", "4", "5", "5"] });
    outcomes.cached(0, "1");
    for (const number of ["2", "3", "4", "5"]) outcomes.begin(0, number, {});
    expect(publish).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    const snapshot = publish.mock.calls[0][0];
    expect(
      snapshot.rows.map(
        ({ outcome }: { outcome: { status: string } }) => outcome.status,
      ),
    ).toEqual(["success", "pending", "pending", "pending", "pending"]);
  });

  it("ignores old generations, replaced requests, double settlement, and removed rows", async () => {
    const publish = vi.fn();
    const outcomes = createReviewerOutcomeCoordinator(publish);
    const old = {};
    const current = {};
    outcomes.reset(initial);
    outcomes.begin(0, "1", old);
    outcomes.reset({ ...initial, generation: 1 });
    outcomes.begin(1, "1", current);
    outcomes.begin(0, "1", old);
    outcomes.settle(0, "1", old, failure);
    outcomes.settle(1, "1", old, failure);
    outcomes.cached(0, "2");
    outcomes.pending(0, "1");
    outcomes.settle(1, "1", current, { status: "success" });
    outcomes.settle(1, "1", current, failure);
    outcomes.reconcile(["1"]);
    outcomes.begin(1, "2", old);
    outcomes.cached(1, "2");
    outcomes.pending(1, "2");
    outcomes.settle(1, "2", old, failure);
    await Promise.resolve();
    expect(publish.mock.lastCall![0]).toMatchObject({
      generation: 1,
      rows: [
        { pullNumber: "1", request: current, outcome: { status: "success" } },
      ],
    });
  });

  it("retains other outcomes during a partial retry and never calls cached display a successful retry", async () => {
    const publish = vi.fn();
    const outcomes = createReviewerOutcomeCoordinator(publish);
    const request = {};
    outcomes.reset(initial);
    outcomes.begin(0, "1", request);
    outcomes.settle(0, "1", request, failure);
    outcomes.cached(0, "2");
    await Promise.resolve();
    const retained = publish.mock.lastCall![0].rows.find(
      (row: { pullNumber: string }) => row.pullNumber === "1",
    );
    publish.mockClear();
    outcomes.cached(0, "1");
    outcomes.cached(0, "2");
    outcomes.reconcile(["1", "2"]);
    outcomes.begin(0, "1", request);
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    outcomes.pending(0, "2");
    outcomes.pending(0, "2");
    outcomes.begin(0, "2", {});
    await Promise.resolve();
    expect(
      publish.mock.lastCall![0].rows.find(
        (row: { pullNumber: string }) => row.pullNumber === "1",
      ),
    ).toBe(retained);
    expect(
      publish.mock.lastCall![0].rows.find(
        (row: { pullNumber: string }) => row.pullNumber === "2",
      ).outcome.status,
    ).toBe("pending");
  });

  it("reconciles removals and additions atomically and lets a replacement row join its live request", async () => {
    const publish = vi.fn();
    const outcomes = createReviewerOutcomeCoordinator(publish);
    const shared = {};
    outcomes.reset(initial);
    outcomes.begin(0, "1", shared);
    outcomes.reconcile(["2"]);
    outcomes.reconcile(["1", "3"]);
    outcomes.begin(0, "1", shared);
    outcomes.settle(0, "1", shared, { status: "success" });
    outcomes.cached(0, "3");
    await Promise.resolve();
    expect(publish.mock.lastCall![0].rows).toHaveLength(2);
    expect(
      publish.mock.lastCall![0].rows.every(
        (row: { outcome: { status: string } }) =>
          row.outcome.status === "success",
      ),
    ).toBe(true);
    outcomes.reconcile([]);
    await Promise.resolve();
    expect(publish.mock.lastCall![0].rows).toEqual([]);
  });
});
