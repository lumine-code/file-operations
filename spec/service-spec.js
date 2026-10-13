let main;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("file-operations package service", () => {
  let directory;
  beforeEach(() => {
    main = require("../lib/main");
    directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lumine-lazy-operations-"));
  });
  afterEach(() => {
    main.deactivate();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

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

  it("publishes its service without loading the executor and shares concurrent first operations", async () => {
    main.activate();
    const owner = main.executor;
    const imported = spyOn(owner, "importExecutor").and.callThrough();
    const service = main.provideFileOperationsExecutor();
    expect(owner.executor).toBe(null);
    expect(imported).not.toHaveBeenCalled();
    const [prepared, inspected] = await Promise.all([service.prepare([]), service.inspect([])]);
    expect(prepared.status).toBe("ready");
    prepared.plan.dispose();
    expect(inspected).toEqual([]);
    expect(imported).toHaveBeenCalledTimes(1);
    expect(owner.executor.constructor).toBe(require("../lib/executor"));
  });

  it("registers lifecycle listeners synchronously before import and respects early disposal", async () => {
    main.activate();
    const service = main.provideFileOperationsExecutor();
    const calls = [];
    const disposed = service.onWillExecuteStep(() => calls.push("disposed"));
    service.onWillExecuteStep(() => calls.push("will"));
    service.onDidExecuteStep(async () => {
      await Promise.resolve();
      calls.push("did");
    });
    const preparing = service.prepare([{ kind: "create", path: path.join(directory, "created") }]);
    disposed.dispose();
    disposed.dispose();
    const prepared = await preparing;
    try {
      expect((await prepared.plan.executeNext()).status).toBe("applied");
      expect(calls).toEqual(["will", "did"]);
    } finally {
      prepared.plan.dispose();
    }
  });

  it("does not import for already cancelled operations", async () => {
    main.activate();
    const imported = spyOn(main.executor, "importExecutor").and.callThrough();
    const service = main.provideFileOperationsExecutor();
    const controller = new AbortController();
    controller.abort();
    expect(await service.prepare([], { signal: controller.signal })).toEqual({
      status: "failed",
      failedOperation: 0,
      reason: "The file operation was aborted.",
    });
    try {
      await service.inspect([], { signal: controller.signal });
      fail("Expected cancellation");
    } catch (error) {
      expect(error.name).toBe("AbortError");
      expect(error.code).toBe("ABORT_ERR");
    }
    expect(imported).not.toHaveBeenCalled();
  });

  it("does not inspect disk after cancellation during import and leaves other callers usable", async () => {
    main.activate();
    const service = main.provideFileOperationsExecutor();
    const owner = main.executor;
    const namespace = await owner.importExecutor();
    const inspected = spyOn(namespace.default.prototype, "inspect").and.callThrough();
    let release;
    spyOn(owner, "importExecutor").and.returnValue(new Promise((resolve) => (release = resolve)));
    const controller = new AbortController();
    const pending = service.inspect([path.join(directory, "missing")], {
      signal: controller.signal,
    });
    controller.abort();
    release(namespace);
    await expectAsync(pending).toBeRejectedWithError(/aborted/);
    expect(inspected).not.toHaveBeenCalled();
    expect(await service.inspect([])).toEqual([]);
    expect(inspected).toHaveBeenCalledTimes(1);
  });

  it("retires a pending import without creating an executor or redirecting old services after reactivation", async () => {
    main.activate();
    const owner = main.executor;
    const oldService = main.provideFileOperationsExecutor();
    const namespace = await owner.importExecutor();
    let release;
    spyOn(owner, "importExecutor").and.returnValue(new Promise((resolve) => (release = resolve)));
    const pending = oldService.prepare([]);
    main.deactivate();
    main.activate();
    const freshService = main.provideFileOperationsExecutor();
    release(namespace);
    expect((await pending).status).toBe("failed");
    expect(owner.executor).toBe(null);
    await expectAsync(oldService.inspect([])).toBeRejectedWithError(/deactivated/);
    expect(await freshService.inspect([])).toEqual([]);
  });

  it("shares a failed import and retries the next operation", async () => {
    main.activate();
    const owner = main.executor;
    const nativeImport = owner.importExecutor.bind(owner);
    const imported = spyOn(owner, "importExecutor").and.returnValue(
      Promise.reject(new Error("temporary load failure")),
    );
    const service = main.provideFileOperationsExecutor();
    const [prepared, inspected] = await Promise.allSettled([
      service.prepare([]),
      service.inspect([]),
    ]);
    expect(prepared.value.status).toBe("failed");
    expect(prepared.value.reason).toBe("temporary load failure");
    expect(inspected.status).toBe("rejected");
    expect(imported).toHaveBeenCalledTimes(1);
    imported.and.callFake(nativeImport);
    expect(await service.inspect([])).toEqual([]);
    expect(imported).toHaveBeenCalledTimes(2);
  });

  it("uses the new executor generation after package unload and retires old services", async () => {
    const lumine = globalThis.lumine;
    main = (await lumine.packages.activatePackage("file-operations")).mainModule;
    const previousMain = main;
    const previousService = main.provideFileOperationsExecutor();
    await previousService.inspect([]);
    const previousConstructor = main.executor.executor.constructor;
    await lumine.packages.unloadPackage("file-operations");
    main = (await lumine.packages.activatePackage("file-operations")).mainModule;
    try {
      const service = main.provideFileOperationsExecutor();
      expect(await service.inspect([])).toEqual([]);
      expect(main).not.toBe(previousMain);
      expect(main.executor.executor.constructor).not.toBe(previousConstructor);
      expect(main.executor.executor.constructor).toBe(require("../lib/executor"));
      await expectAsync(previousService.inspect([])).toBeRejectedWithError(/deactivated/);
    } finally {
      await lumine.packages.deactivatePackage("file-operations");
    }
  });
});
