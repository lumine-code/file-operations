const LazyExecutor = require("./lazy-executor");

module.exports = {
  activate() {
    this.executor?.dispose();
    this.executor = new LazyExecutor();
  },

  deactivate() {
    this.executor?.dispose();
    this.executor = null;
  },

  provideFileOperationsExecutor() {
    const executor = (this.executor ??= new LazyExecutor());
    return Object.freeze({
      prepare: (operations, options) => executor.prepare(operations, options),
      inspect: (paths, options) => executor.inspect(paths, options),
      onWillExecuteStep: (callback) => executor.onWillExecuteStep(callback),
      onDidExecuteStep: (callback) => executor.onDidExecuteStep(callback),
    });
  },
};
