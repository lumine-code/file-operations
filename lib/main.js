const FileOperationsExecutor = require("./executor");

module.exports = {
  activate() {
    this.executor = new FileOperationsExecutor();
  },

  deactivate() {
    this.executor = null;
  },

  provideFileOperationsExecutor() {
    this.executor ??= new FileOperationsExecutor();
    return Object.freeze({
      prepare: (operations, options) => this.executor.prepare(operations, options),
      inspect: (paths, options) => this.executor.inspect(paths, options),
      onWillExecuteStep: (callback) => this.executor.onWillExecuteStep(callback),
      onDidExecuteStep: (callback) => this.executor.onDidExecuteStep(callback),
    });
  },
};
