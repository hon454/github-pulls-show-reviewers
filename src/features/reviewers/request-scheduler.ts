export type AbortAwareRequestScheduler = {
  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T>;
};

type QueuedTask = {
  task: () => Promise<unknown>;
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onAbort: () => void;
};

export function createAbortAwareRequestScheduler(
  concurrency: number,
): AbortAwareRequestScheduler {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      "Request scheduler concurrency must be a positive integer.",
    );
  }

  const queue: QueuedTask[] = [];
  let activeCount = 0;

  function removeAbortListener(task: QueuedTask): void {
    task.signal.removeEventListener("abort", task.onAbort);
  }

  function drain(): void {
    while (activeCount < concurrency) {
      const queuedTask = queue.shift();
      if (queuedTask == null) {
        return;
      }

      removeAbortListener(queuedTask);
      if (queuedTask.signal.aborted) {
        queuedTask.reject(createAbortError());
        continue;
      }

      activeCount += 1;
      void Promise.resolve()
        .then(queuedTask.task)
        .then(queuedTask.resolve, queuedTask.reject)
        .finally(() => {
          activeCount -= 1;
          drain();
        });
    }
  }

  return {
    run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
      if (signal.aborted) {
        return Promise.reject(createAbortError());
      }

      return new Promise<T>((resolve, reject) => {
        const queuedTask: QueuedTask = {
          task,
          signal,
          resolve: (value) => resolve(value as T),
          reject,
          onAbort: () => undefined,
        };
        queuedTask.onAbort = () => {
          const index = queue.indexOf(queuedTask);
          if (index < 0) {
            return;
          }
          queue.splice(index, 1);
          removeAbortListener(queuedTask);
          reject(createAbortError());
        };

        signal.addEventListener("abort", queuedTask.onAbort, { once: true });
        queue.push(queuedTask);
        drain();
      });
    },
  };
}

function createAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }

  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
