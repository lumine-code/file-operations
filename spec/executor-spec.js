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
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-file-operations-"));
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

  it("restores an overwritten rename target when publication fails", async () => {
    const source = write("source.txt", "source");
    const target = write("target.txt", "target");
    const plan = await prepare([
      { kind: "rename", oldPath: source, newPath: target, options: { overwrite: true } },
    ]);
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

  it("does not mistake distinct hard-link names for a case-only rename", async () => {
    if (process.platform === "win32") return;
    const source = write("Linked.txt", "linked");
    const target = at("linked.txt");
    fs.linkSync(source, target);

    const result = await executor.prepare([{ kind: "rename", oldPath: source, newPath: target }]);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("already exists");
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
