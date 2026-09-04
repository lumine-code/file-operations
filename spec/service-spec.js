const main = require("../lib/main");

describe("file-operations package service", () => {
  afterEach(() => main.deactivate());

  it("provides inspection, execution and lifecycle entry points", async () => {
    main.activate();
    const service = main.provideFileOperationsExecutor();

    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.keys(service)).toEqual([
      "prepare",
      "inspect",
      "onWillExecuteStep",
      "onDidExecuteStep",
    ]);
    expect((await service.prepare([])).status).toBe("ready");
    expect(await service.inspect([])).toEqual([]);
  });
});
