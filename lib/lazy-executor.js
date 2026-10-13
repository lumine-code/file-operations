function checkAvailable(owner, signal) {
  if (signal?.aborted || owner.disposed) {
    const error = new Error(
      owner.disposed
        ? "The file-operation service was deactivated."
        : "The file operation was aborted.",
    );
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    throw error;
  }
}

module.exports = class LazyExecutor {
  constructor() {
    this.disposed = false;
    this.executor = null;
    this.pending = null;
    this.listeners = new Set();
  }

  importExecutor() {
    return import("./executor.js");
  }

  async ensure(signal) {
    checkAvailable(this, signal);
    this.pending ??= Promise.resolve()
      .then(() => this.importExecutor())
      .then((namespace) => {
        checkAvailable(this);
        const Executor = namespace.default ?? namespace;
        const executor = new Executor({
          beginFileMove: (renames) => globalThis.lumine.workspace.beginFileMove(renames),
        });
        for (const record of this.listeners)
          record.subscription = executor[record.method](record.callback);
        this.executor = executor;
        return executor;
      })
      .catch((error) => {
        this.pending = null;
        throw error;
      });
    const executor = await this.pending;
    checkAvailable(this, signal);
    return executor;
  }

  async prepare(operations, options) {
    if (!Array.isArray(operations)) {
      return { status: "failed", failedOperation: 0, reason: "File operations must be an array." };
    }
    try {
      const executor = await this.ensure(options?.signal);
      return executor.prepare(operations, options);
    } catch (error) {
      return { status: "failed", failedOperation: 0, reason: error?.message || String(error) };
    }
  }

  async inspect(paths, options) {
    if (!Array.isArray(paths)) throw new TypeError("File inspection paths must be an array.");
    const executor = await this.ensure(options?.signal);
    return executor.inspect(paths, options);
  }

  subscribe(method, callback) {
    if (typeof callback !== "function")
      throw new TypeError("File-operation listener must be a function.");
    checkAvailable(this);
    const record = { method, callback, subscription: this.executor?.[method](callback) };
    this.listeners.add(record);
    return Object.freeze({
      dispose: () => {
        this.listeners.delete(record);
        record.subscription?.dispose();
      },
    });
  }

  onWillExecuteStep(callback) {
    return this.subscribe("onWillExecuteStep", callback);
  }

  onDidExecuteStep(callback) {
    return this.subscribe("onDidExecuteStep", callback);
  }

  dispose() {
    this.disposed = true;
    for (const record of this.listeners) record.subscription?.dispose();
    this.listeners.clear();
  }
};
