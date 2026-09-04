const fs = require("fs");
const os = require("os");
const path = require("path");

const FileOperationsExecutor = require("../lib/executor");

describe("file-operations.executor", () => {
  let root;
  let executor;

  const at = (...parts) => path.join(root, ...parts);
  const write = (relativePath, contents = relativePath) => {
    const filePath = at(relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
    return filePath;
  };
  const prepare = async (operations, options) => {
    const result = await executor.prepare(operations, options);
    expect(result.status).toBe("ready", result.reason);
    return result.plan;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lumine-file-operations-"));
    executor = new FileOperationsExecutor();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("exposes an opaque frozen plan and idempotent disposal", async () => {
    const plan = await prepare([]);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.keys(plan)).toEqual([]);
    expect(await plan.executeNext()).toEqual({ status: "done", effects: [] });

    plan.dispose();
    plan.dispose();
    expect(await plan.executeNext()).toEqual({
      status: "failed",
      reason: "The file operation plan was disposed.",
      effects: [],
    });
  });

  it("describes apply and skip decisions without exposing mutable plan state", async () => {
    const existing = write("existing.txt", "existing");
    const plan = await prepare([
      { kind: "create", path: at("created.txt") },
      { kind: "create", path: existing, options: { ignoreIfExists: true } },
    ]);

    const description = plan.describe();

    expect(description).toEqual([{ status: "apply" }, { status: "skip" }]);
    expect(Object.isFrozen(description)).toBe(true);
    expect(description.every(Object.isFrozen)).toBe(true);
    expect(() => description.push({ status: "apply" })).toThrow();
    description[0].status = "skip";
    expect(plan.describe()).toEqual([{ status: "apply" }, { status: "skip" }]);
  });

  it("returns structured preflight failures with the operation index", async () => {
    const first = at("first.txt");
    const result = await executor.prepare([
      { kind: "create", path: first },
      { kind: "create", path: "relative.txt" },
    ]);

    expect(result).toEqual({
      status: "failed",
      failedOperation: 1,
      reason: "path must be an absolute path.",
    });
    expect(fs.existsSync(first)).toBe(false);
  });

  it("rejects malformed inputs without throwing", async () => {
    expect(await executor.prepare(null)).toEqual({
      status: "failed",
      failedOperation: 0,
      reason: "File operations must be an array.",
    });
    expect((await executor.prepare([{ kind: "copy", path: at("x") }])).status).toBe("failed");
    expect(
      (await executor.prepare([{ kind: "create", path: at("x"), options: { overwrite: 1 } }]))
        .status,
    ).toBe("failed");
  });

  it("inspects files, directories, missing paths and symbolic links in order", async () => {
    const file = write("file.txt", "file");
    const directory = at("directory");
    const link = at("directory-link");
    const dangling = at("dangling-link");
    const missing = at("missing");
    fs.mkdirSync(directory);
    fs.symlinkSync(directory, link, process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync("missing-target", dangling, "file");

    const result = await executor.inspect([file, directory, link, dangling, missing, file]);

    expect(result).toEqual([
      { path: file, status: "file" },
      { path: directory, status: "directory" },
      { path: link, status: "file" },
      { path: dangling, status: "file" },
      { path: missing, status: "missing" },
      { path: file, status: "file" },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
  });

  it("validates an inspection batch before reading and preserves non-missing errors", async () => {
    const file = write("file.txt", "file");
    const lstat = spyOn(fs.promises, "lstat").and.callThrough();

    await expectAsync(executor.inspect([file, "relative.txt"])).toBeRejectedWithError(
      /absolute path/,
    );
    expect(lstat).not.toHaveBeenCalled();

    const failure = new Error("inspection refused");
    failure.code = "EACCES";
    lstat.and.rejectWith(failure);
    await expectAsync(executor.inspect([file])).toBeRejectedWith(failure);
    await expectAsync(executor.inspect(null)).toBeRejectedWithError(/must be an array/);
  });

  it("rejects an aborted inspection without reading", async () => {
    const controller = new AbortController();
    controller.abort();
    const lstat = spyOn(fs.promises, "lstat").and.callThrough();

    let failure;
    try {
      await executor.inspect([at("file.txt")], { signal: controller.signal });
    } catch (error) {
      failure = error;
    }

    expect(failure.name).toBe("AbortError");
    expect(failure.code).toBe("ABORT_ERR");
    expect(lstat).not.toHaveBeenCalled();
  });

  it("emits frozen lifecycle events before I/O and awaits did listeners", async () => {
    const target = at("target.txt");
    const plan = await prepare([{ kind: "create", path: target }]);
    const lstat = spyOn(fs.promises, "lstat").and.callThrough();
    const timeline = [];
    let willEvent;
    let didEvent;
    executor.onWillExecuteStep((event) => {
      willEvent = event;
      timeline.push(`will:${lstat.calls.count()}`);
    });
    executor.onDidExecuteStep(async (event) => {
      didEvent = event;
      timeline.push("did:start");
      await Promise.resolve();
      timeline.push("did:end");
    });

    const result = await plan.executeNext();
    timeline.push("returned");

    expect(result.status).toBe("applied");
    expect(timeline).toEqual(["will:0", "did:start", "did:end", "returned"]);
    expect(Object.isFrozen(willEvent)).toBe(true);
    expect(Object.isFrozen(willEvent.operation)).toBe(true);
    expect(Object.isFrozen(didEvent)).toBe(true);
    expect(Object.isFrozen(didEvent.result)).toBe(true);
    expect(Object.isFrozen(didEvent.result.effects)).toBe(true);
    expect(Object.isFrozen(didEvent.eventTrace)).toBe(true);
    expect(Object.isFrozen(didEvent.eventTrace.internalRoots)).toBe(true);
    expect(Object.isFrozen(didEvent.eventTrace.coveredRoots)).toBe(true);
    expect(didEvent.operationIndex).toBe(0);
    expect(didEvent.id).toBe(willEvent.id);
    expect(didEvent.eventTrace.internalRoots.length).toBe(1);
    expect(didEvent.eventTrace.internalRoots[0].path).toContain(".lumine-create-");
    expect(didEvent.eventTrace.internalRoots[0].recursive).toBe(false);
    expect(didEvent.eventTrace.coveredRoots).toEqual([{ path: target, recursive: false }]);
  });

  it("isolates lifecycle listener failures and supports idempotent disposal", async () => {
    const target = at("target.txt");
    const plan = await prepare([{ kind: "create", path: target }]);
    spyOn(console, "error");
    const calls = [];
    executor.onWillExecuteStep(() => {
      calls.push("will-failed");
      throw new Error("will failed");
    });
    const disposed = executor.onWillExecuteStep(() => calls.push("disposed"));
    disposed.dispose();
    disposed.dispose();
    executor.onWillExecuteStep(() => calls.push("will-ok"));
    executor.onDidExecuteStep(async () => {
      calls.push("did-failed");
      throw new Error("did failed");
    });
    executor.onDidExecuteStep(() => calls.push("did-ok"));

    const result = await plan.executeNext();

    expect(result.status).toBe("applied");
    expect(calls).toEqual(["will-failed", "will-ok", "did-failed", "did-ok"]);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("creates an empty file and its missing parent directories", async () => {
    const target = at("nested", "deeper", "file.txt");
    const plan = await prepare([{ kind: "create", path: target }]);

    const result = await plan.executeNext();

    expect(result.status).toBe("applied");
    expect(result.effects).toEqual([
      { kind: "create", path: at("nested"), isDirectory: true },
      { kind: "create", path: at("nested", "deeper"), isDirectory: true },
      { kind: "create", path: target, isDirectory: false },
    ]);
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("simulates create, rename and delete before executing any step", async () => {
    const created = at("created.txt");
    const renamed = at("renamed.txt");
    const plan = await prepare([
      { kind: "create", path: created },
      { kind: "rename", oldPath: created, newPath: renamed },
      { kind: "delete", path: renamed },
    ]);

    expect(fs.existsSync(created)).toBe(false);
    expect((await plan.executeNext()).effects.at(-1)).toEqual({
      kind: "create",
      path: created,
      isDirectory: false,
    });
    expect(await plan.executeNext()).toEqual({
      status: "applied",
      effects: [{ kind: "rename", oldPath: created, newPath: renamed, isDirectory: false }],
    });
    expect(await plan.executeNext()).toEqual({
      status: "applied",
      effects: [{ kind: "delete", path: renamed, isDirectory: false }],
    });
    expect(await plan.executeNext()).toEqual({ status: "done", effects: [] });
  });

  it("supports rename chains through a directory subtree", async () => {
    const source = at("source");
    const destination = at("destination");
    fs.mkdirSync(source);
    write(path.join("source", "child.txt"), "child");
    const plan = await prepare([
      { kind: "rename", oldPath: source, newPath: destination },
      { kind: "delete", path: path.join(destination, "child.txt") },
      { kind: "delete", path: destination },
    ]);

    expect((await plan.executeNext()).status).toBe("applied");
    expect((await plan.executeNext()).status).toBe("applied");
    expect((await plan.executeNext()).status).toBe("applied");
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("supports delete followed by create at the same path", async () => {
    const target = write("same.txt", "old");
    const plan = await prepare([
      { kind: "delete", path: target },
      { kind: "create", path: target },
    ]);

    expect((await plan.executeNext()).status).toBe("applied");
    expect((await plan.executeNext()).status).toBe("applied");
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("supports an ordered swap through a temporary path", async () => {
    const first = write("first.txt", "first");
    const second = write("second.txt", "second");
    const temporary = at("temporary.txt");
    const plan = await prepare([
      { kind: "rename", oldPath: first, newPath: temporary },
      { kind: "rename", oldPath: second, newPath: first },
      { kind: "rename", oldPath: temporary, newPath: second },
    ]);

    expect((await plan.executeNext()).status).toBe("applied");
    expect((await plan.executeNext()).status).toBe("applied");
    expect((await plan.executeNext()).status).toBe("applied");
    expect(fs.readFileSync(first, "utf8")).toBe("second");
    expect(fs.readFileSync(second, "utf8")).toBe("first");
  });

  it("preflights the complete sequence before the first mutation", async () => {
    const first = at("first.txt");
    const missing = at("missing.txt");
    const result = await executor.prepare([
      { kind: "create", path: first },
      { kind: "delete", path: missing },
    ]);

    expect(result.status).toBe("failed");
    expect(result.failedOperation).toBe(1);
    expect(fs.existsSync(first)).toBe(false);
  });

  it("revalidates every baseline read before the first mutation", async () => {
    const first = at("first.txt");
    const later = write("later.txt", "original");
    const plan = await prepare([
      { kind: "create", path: first },
      { kind: "delete", path: later },
    ]);
    fs.writeFileSync(later, "changed");

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("changed after");
    expect(result.effects).toEqual([]);
    expect(fs.existsSync(first)).toBe(false);
  });

  it("rejects a source replaced between prepare and execute", async () => {
    const source = write("source.txt", "source");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    fs.rmSync(source);
    fs.writeFileSync(source, "replacement");

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(fs.readFileSync(source, "utf8")).toBe("replacement");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("treats ignored conflicts as explicit skipped steps", async () => {
    const createTarget = write("create.txt", "keep");
    const renameSource = write("source.txt", "source");
    const renameTarget = write("target.txt", "target");
    const plan = await prepare([
      { kind: "create", path: createTarget, options: { ignoreIfExists: true } },
      {
        kind: "rename",
        oldPath: renameSource,
        newPath: renameTarget,
        options: { ignoreIfExists: true },
      },
      { kind: "delete", path: at("absent.txt"), options: { ignoreIfNotExists: true } },
    ]);

    expect(await plan.executeNext()).toEqual({ status: "skipped", effects: [] });
    expect(await plan.executeNext()).toEqual({ status: "skipped", effects: [] });
    expect(await plan.executeNext()).toEqual({ status: "skipped", effects: [] });
    expect(fs.readFileSync(createTarget, "utf8")).toBe("keep");
    expect(fs.readFileSync(renameSource, "utf8")).toBe("source");
    expect(fs.readFileSync(renameTarget, "utf8")).toBe("target");
  });

  it("lets overwrite take precedence over ignoreIfExists", async () => {
    const target = write("target.txt", "old");
    const plan = await prepare([
      {
        kind: "create",
        path: target,
        options: { overwrite: true, ignoreIfExists: true },
      },
    ]);

    const result = await plan.executeNext();

    expect(result.status).toBe("applied");
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("restores a file when overwriting create cannot publish", async () => {
    const target = write("target.txt", "original");
    const plan = await prepare([{ kind: "create", path: target, options: { overwrite: true } }]);
    spyOn(fs.promises, "link").and.callFake(async (_from, to) => {
      if (to === target) {
        const error = new Error("publication refused");
        error.code = "EACCES";
        throw error;
      }
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(fs.readdirSync(root)).toEqual(["target.txt"]);
  });

  it("cleans and covers a destination reservation when its first lstat fails", async () => {
    const source = write("source.txt", "source");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    let didEvent;
    executor.onDidExecuteStep((event) => (didEvent = event));
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let failed = false;
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (!failed && filePath === target && fs.existsSync(target)) {
        failed = true;
        const error = new Error("reservation inspection failed");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.existsSync(target)).toBe(false);
    expect(didEvent.eventTrace.internalRoots).toEqual([]);
    expect(didEvent.eventTrace.coveredRoots).toEqual([{ path: target, recursive: false }]);
  });

  it("reports a destination reservation that stays unreadable", async () => {
    const source = write("source.txt", "source");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (filePath === target && fs.existsSync(target)) {
        const error = new Error("reservation unreadable");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([]);
    expect(result.cleanupPaths).toEqual([target]);
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("reports an uninspectable create stage as an internal recovery path", async () => {
    const target = at("target.txt");
    const plan = await prepare([{ kind: "create", path: target }]);
    let didEvent;
    executor.onDidExecuteStep((event) => (didEvent = event));
    const originalOpen = fs.promises.open.bind(fs.promises);
    spyOn(fs.promises, "open").and.callFake(async (filePath, ...args) => {
      const handle = await originalOpen(filePath, ...args);
      if (!path.basename(filePath).includes(".lumine-create-")) return handle;
      return {
        close: () => handle.close(),
        stat: async () => {
          throw new Error("stage inspection failed");
        },
      };
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(result.cleanupPaths.length).toBe(1);
    expect(result.cleanupPaths[0]).toContain(".lumine-create-");
    expect(fs.existsSync(result.cleanupPaths[0])).toBe(true);
    expect(didEvent.eventTrace.internalRoots).toEqual([
      { path: result.cleanupPaths[0], recursive: false },
    ]);
    expect(didEvent.eventTrace.coveredRoots).toEqual([]);
  });

  it("reports a parent created before its snapshot fails", async () => {
    const parent = at("created-parent");
    const target = path.join(parent, "target.txt");
    const plan = await prepare([{ kind: "create", path: target }]);
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let failed = false;
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (!failed && filePath === parent && fs.existsSync(parent)) {
        failed = true;
        throw new Error("parent inspection failed");
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([{ kind: "create", path: parent, isDirectory: true }]);
    expect(result.cleanupPaths).toEqual([parent]);
    expect(fs.existsSync(parent)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("reports a published create when post-commit lstat fails", async () => {
    const target = at("target.txt");
    const plan = await prepare([{ kind: "create", path: target }]);
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let failed = false;
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (!failed && filePath === target && fs.existsSync(target)) {
        failed = true;
        throw new Error("published target inspection failed");
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([{ kind: "create", path: target, isDirectory: false }]);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("preserves a committed create result when its stage stays unreadable", async () => {
    const target = at("target.txt");
    const plan = await prepare([{ kind: "create", path: target }]);
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let targetFailed = false;
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (path.basename(filePath).includes(".lumine-create-")) {
        const error = new Error("stage unreadable");
        error.code = "EACCES";
        throw error;
      }
      if (!targetFailed && filePath === target && fs.existsSync(target)) {
        targetFailed = true;
        throw new Error("target bookkeeping failed");
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([{ kind: "create", path: target, isDirectory: false }]);
    expect(result.cleanupPaths.length).toBe(1);
    expect(result.cleanupPaths[0]).toContain(".lumine-create-");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(result.cleanupPaths[0])).toBe(true);
  });

  it("reports an owned reservation that cannot be cleaned as a durable create", async () => {
    const source = write("source.txt", "source");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) throw new Error("publication failed");
      return originalRename(from, to);
    });
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    spyOn(fs.promises, "unlink").and.callFake(async (filePath) => {
      if (filePath === target) throw new Error("reservation cleanup failed");
      return originalUnlink(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([{ kind: "create", path: target, isDirectory: false }]);
    expect(result.cleanupPaths).toEqual([target]);
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("reports the actual Windows reservation type after a directory publish failure", async () => {
    if (process.platform !== "win32") return;
    const source = at("source");
    const target = at("target");
    fs.mkdirSync(source);
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) throw new Error("publication failed");
      return originalRename(from, to);
    });
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    spyOn(fs.promises, "unlink").and.callFake(async (filePath) => {
      if (filePath === target) throw new Error("reservation cleanup failed");
      return originalUnlink(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([{ kind: "create", path: target, isDirectory: false }]);
    expect(fs.lstatSync(target).isFile()).toBe(true);
    expect(fs.existsSync(source)).toBe(true);
  });

  it("restores an overwritten rename target when publication fails", async () => {
    const source = write("source.txt", "source");
    const target = write("target.txt", "target");
    const plan = await prepare([
      { kind: "rename", oldPath: source, newPath: target, options: { overwrite: true } },
    ]);
    let didEvent;
    executor.onDidExecuteStep((event) => (didEvent = event));
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("publication refused");
        error.code = "EACCES";
        throw error;
      }
      return originalRename(from, to);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.readFileSync(target, "utf8")).toBe("target");
    expect(didEvent.eventTrace.internalRoots.length).toBe(1);
    expect(didEvent.eventTrace.internalRoots[0].path).toContain(".lumine-backup-");
    expect(didEvent.eventTrace.internalRoots[0].recursive).toBe(false);
    expect(didEvent.eventTrace.coveredRoots).toEqual([{ path: target, recursive: false }]);
  });

  it("renames across devices through a verified staged copy", async () => {
    const source = write("source.txt", "source contents");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return originalRename(from, to);
    });

    const result = await plan.executeNext();

    expect(result).toEqual({
      status: "applied",
      effects: [{ kind: "rename", oldPath: source, newPath: target, isDirectory: false }],
    });
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("source contents");
  });

  it("does not replace a destination that wins the final rename race after inode reuse", async () => {
    const source = write("source.txt", "source contents");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    let didEvent;
    executor.onDidExecuteStep((event) => (didEvent = event));
    const originalOpen = fs.promises.open.bind(fs.promises);
    let reservationIdentity;
    spyOn(fs.promises, "open").and.callFake(async (filePath, ...args) => {
      const handle = await originalOpen(filePath, ...args);
      if (filePath !== target) return handle;
      return {
        close: () => handle.close(),
        stat: async () => {
          const stat = await handle.stat();
          reservationIdentity = { dev: stat.dev, ino: stat.ino };
          return stat;
        },
      };
    });
    const originalRename = fs.promises.rename.bind(fs.promises);
    let reservationObserved = false;
    let externalReplaced = false;
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        reservationObserved = fs.existsSync(target);
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        fs.writeFileSync(target, "external");
        externalReplaced = true;
        const error = new Error("destination appeared");
        error.code = "EEXIST";
        throw error;
      }
      return originalRename(from, to);
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      const stat = await originalLstat(filePath);
      if (externalReplaced && filePath === target) {
        stat.dev = reservationIdentity.dev;
        stat.ino = reservationIdentity.ino;
      }
      return stat;
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(reservationObserved).toBe(true);
    expect(fs.readFileSync(source, "utf8")).toBe("source contents");
    expect(fs.readFileSync(target, "utf8")).toBe("external");
    expect(didEvent.eventTrace.coveredRoots).toEqual([]);
  });

  it("restores an EXDEV source when an inode-reusing destination replaces the publication", async () => {
    const source = write("source.txt", "source contents");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let externalReplaced = false;
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      const result = await originalRename(from, to);
      if (path.basename(from).includes(".lumine-copy-") && to === target) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.writeFileSync(target, "external");
        externalReplaced = true;
      }
      return result;
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let stagedIdentity;
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      const stat = await originalLstat(filePath);
      if (path.basename(filePath).includes(".lumine-copy-")) {
        stagedIdentity = { dev: stat.dev, ino: stat.ino };
      } else if (externalReplaced && filePath === target) {
        stat.dev = stagedIdentity.dev;
        stat.ino = stagedIdentity.ino;
      }
      return stat;
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(fs.readFileSync(source, "utf8")).toBe("source contents");
    expect(fs.readFileSync(target, "utf8")).toBe("external");
  });

  it("restores an EXDEV source and reports an unreadable published destination", async () => {
    const source = write("source.txt", "source contents");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let published = false;
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      const result = await originalRename(from, to);
      if (path.basename(from).includes(".lumine-copy-") && to === target) published = true;
      return result;
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (published && filePath === target) {
        const error = new Error("destination unreadable");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([{ kind: "create", path: target, isDirectory: false }]);
    expect(result.cleanupPaths).toContain(target);
    expect(fs.readFileSync(source, "utf8")).toBe("source contents");
    expect(fs.readFileSync(target, "utf8")).toBe("source contents");
  });

  it("restores late EXDEV source writes instead of deleting them", async () => {
    const source = write("source.txt", "source contents");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      const result = await originalRename(from, to);
      if (path.basename(from).includes(".lumine-copy-") && to === target) {
        const tombstone = fs
          .readdirSync(root)
          .find((name) => name.includes(".source.txt.lumine-move-"));
        fs.appendFileSync(path.join(root, tombstone), " plus late write");
      }
      return result;
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(fs.readFileSync(source, "utf8")).toBe("source contents plus late write");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refreshes referenced descendant identities after an EXDEV directory rename", async () => {
    const source = at("source");
    const target = at("target");
    const sourceChild = write(path.join("source", "child.txt"), "child");
    const targetChild = path.join(target, "child.txt");
    const plan = await prepare([
      { kind: "rename", oldPath: source, newPath: target },
      { kind: "delete", path: targetChild },
    ]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return originalRename(from, to);
    });

    expect((await plan.executeNext()).status).toBe("applied");
    expect((await plan.executeNext()).status).toBe("applied");
    expect(fs.existsSync(sourceChild)).toBe(false);
    expect(fs.existsSync(targetChild)).toBe(false);
  });

  it("ignores filesystem-specific directory sizes when verifying an EXDEV copy", async () => {
    const source = at("source");
    const target = at("target");
    write(path.join("source", "nested", "file.txt"), "contents");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return originalRename(from, to);
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      const stat = await originalLstat(filePath);
      if (String(filePath).includes(".lumine-copy-") && stat.isDirectory()) stat.size += 8192;
      return stat;
    });

    expect((await plan.executeNext()).status).toBe("applied");
    expect(fs.readFileSync(path.join(target, "nested", "file.txt"), "utf8")).toBe("contents");
  });

  it("reports every EXDEV recovery entry that cleanup could not remove", async () => {
    const source = write("source.txt", "source");
    const target = write("target.txt", "target");
    const plan = await prepare([
      { kind: "rename", oldPath: source, newPath: target, options: { overwrite: true } },
    ]);
    let didEvent;
    executor.onDidExecuteStep((event) => (didEvent = event));
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return originalRename(from, to);
    });
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    spyOn(fs.promises, "unlink").and.callFake(async (filePath) => {
      const name = path.basename(filePath);
      if (name.includes(".lumine-move-") || name.includes(".lumine-backup-")) {
        throw new Error("cleanup refused");
      }
      return originalUnlink(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("applied");
    expect(result.cleanupPaths.length).toBe(2);
    expect(result.cleanupPath).toBeUndefined();
    expect(result.cleanupPaths.some((filePath) => filePath.includes(".lumine-move-"))).toBe(true);
    expect(result.cleanupPaths.some((filePath) => filePath.includes(".lumine-backup-"))).toBe(true);
    expect(result.cleanupPaths.every((filePath) => fs.existsSync(filePath))).toBe(true);
    for (const cleanupPath of result.cleanupPaths) {
      expect(didEvent.eventTrace.internalRoots).toContain({
        path: cleanupPath,
        recursive: false,
      });
    }
    expect(didEvent.eventTrace.coveredRoots).toContain({ path: source, recursive: false });
    expect(didEvent.eventTrace.coveredRoots).toContain({ path: target, recursive: false });
  });

  it("restores an EXDEV source when copying fails", async () => {
    const source = write("source.txt", "source contents");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return originalRename(from, to);
    });
    spyOn(fs.promises, "cp").and.callFake(async (_from, to) => {
      fs.writeFileSync(to, "partial");
      const error = new Error("disk full");
      error.code = "ENOSPC";
      throw error;
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(fs.readFileSync(source, "utf8")).toBe("source contents");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(root).sort()).toEqual(["source.txt"]);
  });

  it("preserves a directory tree during EXDEV rename", async () => {
    const source = at("source");
    const target = at("target");
    fs.mkdirSync(source);
    write(path.join("source", "nested", "file.txt"), "contents");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    let didEvent;
    executor.onDidExecuteStep((event) => (didEvent = event));
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return originalRename(from, to);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("applied");
    expect(fs.readFileSync(path.join(target, "nested", "file.txt"), "utf8")).toBe("contents");
    expect(fs.existsSync(source)).toBe(false);
    expect(didEvent.eventTrace.internalRoots.length).toBe(2);
    expect(didEvent.eventTrace.internalRoots.every(({ recursive }) => recursive)).toBe(true);
    expect(didEvent.eventTrace.coveredRoots).toContain({ path: source, recursive: true });
    expect(didEvent.eventTrace.coveredRoots).toContain({ path: target, recursive: true });
  });

  it("preserves a dangling symbolic link during EXDEV rename", async () => {
    const source = at("source-link");
    const target = at("target-link");
    fs.symlinkSync("missing-target", source, "file");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (from === source && to === target) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return originalRename(from, to);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("applied");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe("missing-target");
    expect(() => fs.lstatSync(source)).toThrow();
  });

  it("renames a symbolic link without touching its referent", async () => {
    const referent = write("referent.txt", "referent");
    const source = at("source-link");
    const target = at("target-link");
    fs.symlinkSync(path.basename(referent), source, "file");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);

    const result = await plan.executeNext();

    expect(result).toEqual({
      status: "applied",
      effects: [{ kind: "rename", oldPath: source, newPath: target, isDirectory: false }],
    });
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(path.basename(referent));
    expect(fs.readFileSync(referent, "utf8")).toBe("referent");
  });

  it("deletes a dangling symbolic link as a leaf", async () => {
    const target = at("dangling-link");
    fs.symlinkSync("missing-target", target, "file");
    const plan = await prepare([{ kind: "delete", path: target }]);

    const result = await plan.executeNext();

    expect(result).toEqual({
      status: "applied",
      effects: [{ kind: "delete", path: target, isDirectory: false }],
    });
    expect(fs.existsSync(target)).toBe(false);
    expect(() => fs.lstatSync(target)).toThrow();
  });

  it("reports a committed delete when parent bookkeeping fails", async () => {
    const target = write("target.txt", "target");
    const plan = await prepare([{ kind: "delete", path: target }]);
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    let deleted = false;
    spyOn(fs.promises, "unlink").and.callFake(async (filePath) => {
      const result = await originalUnlink(filePath);
      if (path.basename(filePath).includes(".lumine-delete-")) deleted = true;
      return result;
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (deleted && filePath === root) throw new Error("bookkeeping failed");
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([{ kind: "delete", path: target, isDirectory: false }]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("reports a moved delete tombstone when recovery paths stay unreadable", async () => {
    const target = write("target.txt", "target");
    const plan = await prepare([{ kind: "delete", path: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let tombstone;
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      const result = await originalRename(from, to);
      if (from === target) tombstone = to;
      return result;
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (tombstone && (filePath === tombstone || filePath === target)) {
        const error = new Error("delete path unreadable");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([{ kind: "delete", path: target, isDirectory: false }]);
    expect(result.cleanupPaths).toEqual([tombstone]);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(tombstone)).toBe(true);
  });

  it("overwrites a symlink without changing its referent", async () => {
    const referent = write("referent.txt", "referent");
    const target = at("link");
    fs.symlinkSync(path.basename(referent), target, "file");
    const plan = await prepare([{ kind: "create", path: target, options: { overwrite: true } }]);

    const result = await plan.executeNext();

    expect(result.status).toBe("applied");
    expect(fs.lstatSync(target).isFile()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("");
    expect(fs.readFileSync(referent, "utf8")).toBe("referent");
  });

  it("deletes an empty directory without recursive", async () => {
    const directory = at("empty");
    fs.mkdirSync(directory);
    const plan = await prepare([{ kind: "delete", path: directory }]);

    expect(await plan.executeNext()).toEqual({
      status: "applied",
      effects: [{ kind: "delete", path: directory, isDirectory: true }],
    });
  });

  it("rejects a non-empty directory without recursive during preflight", async () => {
    const directory = at("full");
    write(path.join("full", "file.txt"));

    const result = await executor.prepare([{ kind: "delete", path: directory }]);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("non-empty directory");
    expect(fs.existsSync(directory)).toBe(true);
  });

  it("revalidates an empty-directory listing before deleting it", async () => {
    const directory = at("empty");
    fs.mkdirSync(directory);
    const plan = await prepare([{ kind: "delete", path: directory }]);
    const child = path.join(directory, "late.txt");
    fs.writeFileSync(child, "late");

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(fs.readFileSync(child, "utf8")).toBe("late");
  });

  it("deletes a directory recursively", async () => {
    const directory = at("full");
    write(path.join("full", "nested", "file.txt"));
    const plan = await prepare([{ kind: "delete", path: directory, options: { recursive: true } }]);

    expect((await plan.executeNext()).status).toBe("applied");
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("reports exact remaining child effects after a partial recursive delete", async () => {
    const directory = at("full");
    const first = write(path.join("full", "first.txt"), "first");
    write(path.join("full", "second.txt"), "second");
    const plan = await prepare([{ kind: "delete", path: directory, options: { recursive: true } }]);
    let didEvent;
    executor.onDidExecuteStep((event) => (didEvent = event));
    spyOn(fs.promises, "rm").and.callFake(async (target) => {
      if (path.basename(target).includes("lumine-delete")) {
        await fs.promises.unlink(path.join(target, "first.txt"));
        throw new Error("partial removal");
      }
      throw new Error(`Unexpected removal: ${target}`);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([{ kind: "delete", path: first, isDirectory: false }]);
    expect(didEvent.eventTrace.internalRoots.length).toBe(1);
    expect(didEvent.eventTrace.internalRoots[0].path).toContain(".lumine-delete-");
    expect(didEvent.eventTrace.internalRoots[0].recursive).toBe(true);
    expect(didEvent.eventTrace.coveredRoots).toEqual([
      { path: directory, recursive: true },
      { path: first, recursive: false },
    ]);
    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.readFileSync(path.join(directory, "second.txt"), "utf8")).toBe("second");
  });

  it("aborts prepare and execute without mutation", async () => {
    const target = at("target.txt");
    const controller = new AbortController();
    controller.abort();
    const failed = await executor.prepare([{ kind: "create", path: target }], {
      signal: controller.signal,
    });
    expect(failed.status).toBe("failed");

    const plan = await prepare([{ kind: "create", path: target }]);
    const result = await plan.executeNext({ signal: controller.signal });
    expect(result.status).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("treats an identical rename as a successful no-op", async () => {
    const target = write("same.txt", "same");
    const plan = await prepare([{ kind: "rename", oldPath: target, newPath: target }]);

    expect(await plan.executeNext()).toEqual({ status: "skipped", effects: [] });
    expect(fs.readFileSync(target, "utf8")).toBe("same");
  });

  it("applies a case-only rename without replacing another entry", async () => {
    const source = write("MixedCase.txt", "case");
    const target = at("mixedcase.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);

    const result = await plan.executeNext();

    expect(result.status).toBe("applied");
    expect(fs.readdirSync(root)).toContain("mixedcase.txt");
    expect(fs.readFileSync(target, "utf8")).toBe("case");
  });

  it("applies a case-only rename of a file created by an earlier plan step", async () => {
    const source = at("MixedCase.txt");
    const target = at("mixedcase.txt");
    const plan = await prepare([
      { kind: "create", path: source },
      { kind: "rename", oldPath: source, newPath: target },
    ]);

    expect(plan.describe()).toEqual([{ status: "apply" }, { status: "apply" }]);
    const createResult = await plan.executeNext();
    expect(createResult.status).toBe("applied", createResult.reason);
    const renameResult = await plan.executeNext();
    expect(renameResult.status).toBe("applied", renameResult.reason);
    expect(fs.readdirSync(root)).toContain("mixedcase.txt");
  });

  it("reports a committed rename when post-commit bookkeeping fails", async () => {
    const source = write("source.txt", "source");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let published = false;
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      const result = await originalRename(from, to);
      if (from === source && to === target) published = true;
      return result;
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let publishedTargetReads = 0;
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (published && filePath === target && ++publishedTargetReads === 2) {
        throw new Error("bookkeeping failed");
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([
      { kind: "rename", oldPath: source, newPath: target, isDirectory: false },
    ]);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("source");
  });

  it("reports a committed local rename when its destination stays unreadable", async () => {
    const source = write("source.txt", "source");
    const target = at("target.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let published = false;
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      const result = await originalRename(from, to);
      if (from === source && to === target) published = true;
      return result;
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (published && filePath === target) {
        const error = new Error("destination unreadable");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([
      { kind: "rename", oldPath: source, newPath: target, isDirectory: false },
    ]);
    expect(result.cleanupPaths).toEqual([target]);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("source");
  });

  it("reports a committed case-only rename when its destination stays unreadable", async () => {
    if (process.platform !== "win32") return;
    const source = write("MixedCase.txt", "source");
    const target = at("mixedcase.txt");
    const plan = await prepare([{ kind: "rename", oldPath: source, newPath: target }]);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let published = false;
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      const result = await originalRename(from, to);
      if (path.basename(from).includes(".lumine-case-") && to === target) published = true;
      return result;
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    spyOn(fs.promises, "lstat").and.callFake(async (filePath) => {
      if (published && filePath === target) {
        const error = new Error("destination unreadable");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat(filePath);
    });

    const result = await plan.executeNext();

    expect(result.status).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.effects).toEqual([
      { kind: "rename", oldPath: source, newPath: target, isDirectory: false },
    ]);
    expect(result.cleanupPaths).toEqual([target]);
    expect(fs.readdirSync(root)).toContain("mixedcase.txt");
  });

  it("treats distinct hard-link names as a destination conflict", async () => {
    const source = write("linked-source.txt", "linked");
    const target = at("linked-alias.txt");
    fs.linkSync(source, target);

    const result = await executor.prepare([{ kind: "rename", oldPath: source, newPath: target }]);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("already exists");
  });

  it("can overwrite a distinct hard-link name without treating its ctime change as stale", async () => {
    const source = write("source.txt", "linked");
    const target = at("target.txt");
    fs.linkSync(source, target);
    const plan = await prepare([
      { kind: "rename", oldPath: source, newPath: target, options: { overwrite: true } },
    ]);

    const result = await plan.executeNext();

    expect(result.status).toBe("applied");
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("linked");
  });

  it("refuses to move a directory into itself or replace its ancestor", async () => {
    const source = at("source");
    fs.mkdirSync(path.join(source, "child"), { recursive: true });

    const intoSelf = await executor.prepare([
      { kind: "rename", oldPath: source, newPath: path.join(source, "child", "moved") },
    ]);
    const overAncestor = await executor.prepare([
      {
        kind: "rename",
        oldPath: path.join(source, "child"),
        newPath: source,
        options: { overwrite: true },
      },
    ]);

    expect(intoSelf.status).toBe("failed");
    expect(overAncestor.status).toBe("failed");
  });

  it("refuses filesystem roots and a symlink used as a destination parent", async () => {
    const rootResult = await executor.prepare([
      { kind: "delete", path: path.parse(root).root, options: { recursive: true } },
    ]);
    expect(rootResult.status).toBe("failed");

    const realDirectory = at("real");
    const linkedDirectory = at("linked");
    fs.mkdirSync(realDirectory);
    fs.symlinkSync(
      realDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const linkedResult = await executor.prepare([
      { kind: "create", path: path.join(linkedDirectory, "file.txt") },
    ]);
    expect(linkedResult.status).toBe("failed");
    expect(linkedResult.reason).toContain("not a directory");
  });
});
