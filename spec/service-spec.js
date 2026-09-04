const main = require("../lib/main");

describe("file-operations package service", () => {
  afterEach(() => main.deactivate());

  it("provides only the preflight entry point", async () => {
    main.activate();
    const service = main.provideFileOperationsExecutor();

    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.keys(service)).toEqual(["prepare"]);
    expect((await service.prepare([])).status).toBe("ready");
  });
});
