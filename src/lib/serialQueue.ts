export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);

    // Ensure the queue continues even if `fn` throws.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

