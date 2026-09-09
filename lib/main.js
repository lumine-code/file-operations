const FileOperationsExecutor = require("./executor");

function createExecutor() {
  return new FileOperationsExecutor({
    beginFileMove: (renames) => globalThis.lumine.workspace.beginFileMove(renames),
  });
}

module.exports = {
  activate() {
    this.executor = createExecutor();
  },

  deactivate() {
    this.executor = null;
  },

  provideFileOperationsExecutor() {
    this.executor ??= createExecutor();
    return Object.freeze({
      prepare: (operations, options) => this.executor.prepare(operations, options),
      inspect: (paths, options) => this.executor.inspect(paths, options),
      onWillExecuteStep: (callback) => this.executor.onWillExecuteStep(callback),
      onDidExecuteStep: (callback) => this.executor.onDidExecuteStep(callback),
    });
  },
};
