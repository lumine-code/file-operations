const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const fsp = fs.promises;

class PlanFailure extends Error {
  constructor(index, message) {
    super(message);
    this.index = index;
  }
}

class OperationFailure extends Error {
  constructor(message, { effects = [], cleanupPaths = [], partial = effects.length > 0 } = {}) {
    super(message);
    this.effects = effects;
    this.cleanupPaths = uniquePaths(cleanupPaths);
    this.partial = partial;
  }
}

function uniquePaths(paths = []) {
  return [...new Set(paths.filter(Boolean))];
}

function appendCleanupPaths(target, ...paths) {
  for (const cleanupPath of paths.flat()) {
    if (cleanupPath && !target.includes(cleanupPath)) target.push(cleanupPath);
  }
  return target;
}

function cleanupFields(paths) {
  const cleanupPaths = uniquePaths(paths);
  return cleanupPaths.length ? { cleanupPaths } : {};
}

function abortError() {
  const error = new Error("The file operation was aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function reasonFor(error) {
  return error?.message || String(error);
}

function missingPathError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function normalizeAbsolute(filePath, field) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (filePath.includes("\0")) throw new Error(`${field} contains a null byte.`);
  if (!path.isAbsolute(filePath)) throw new Error(`${field} must be an absolute path.`);
  return path.normalize(filePath);
}

function pathKey(filePath) {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left, right) {
  return pathKey(left) === pathKey(right);
}

function pathContains(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function equalOrContained(parentPath, childPath) {
  return pathsEqual(parentPath, childPath) || pathContains(parentPath, childPath);
}

function isRootPath(filePath) {
  return pathsEqual(filePath, path.parse(filePath).root);
}

async function snapshot(filePath) {
  try {
    const stat = await fsp.lstat(filePath);
    const result = {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      birthtimeMs: stat.birthtimeMs,
      ctimeMs: stat.ctimeMs,
      mtimeMs: stat.mtimeMs,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
    if (result.isSymbolicLink) result.linkTarget = await fsp.readlink(filePath);
    return result;
  } catch (error) {
    if (missingPathError(error)) return null;
    throw error;
  }
}

function snapshotsEqual(left, right) {
  if (!left || !right) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.isDirectory === right.isDirectory &&
    left.isSymbolicLink === right.isSymbolicLink &&
    left.linkTarget === right.linkTarget
  );
}

function identitiesEqual(left, right) {
  if (!left || !right) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isDirectory === right.isDirectory &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}

function privateSibling(filePath, label) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.lumine-${label}-${process.pid}-${crypto.randomUUID()}`,
  );
}

function createEffect(filePath, isDirectory) {
  return { kind: "create", path: filePath, isDirectory };
}

function renameEffect(oldPath, newPath, isDirectory) {
  return { kind: "rename", oldPath, newPath, isDirectory };
}

function deleteEffect(filePath, isDirectory) {
  return { kind: "delete", path: filePath, isDirectory };
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function treeManifest(rootPath) {
  const entries = new Map();
  const visit = async (entryPath, relativePath) => {
    const current = await snapshot(entryPath);
    if (!current) throw new Error(`'${entryPath}' disappeared while it was being copied.`);
    const record = {
      isDirectory: current.isDirectory,
      isSymbolicLink: current.isSymbolicLink,
      mode: current.mode & 0o7777,
      linkTarget: current.linkTarget,
    };
    if (!current.isDirectory && !current.isSymbolicLink) {
      const stat = await fsp.lstat(entryPath);
      if (!stat.isFile()) {
        const error = new Error(`Cannot copy special filesystem entry '${entryPath}'.`);
        error.code = "ENOTSUP";
        throw error;
      }
      record.size = current.size;
      record.hash = await hashFile(entryPath);
    }
    entries.set(relativePath, record);
    if (!current.isDirectory || current.isSymbolicLink) return;
    const names = await fsp.readdir(entryPath);
    names.sort();
    for (const name of names) {
      await visit(path.join(entryPath, name), relativePath ? `${relativePath}/${name}` : name);
    }
  };
  await visit(rootPath, "");
  return entries;
}

function manifestsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [entryPath, expected] of left) {
    const actual = right.get(entryPath);
    if (!actual) return false;
    for (const key of ["isDirectory", "isSymbolicLink", "linkTarget", "size", "hash"]) {
      if (actual[key] !== expected[key]) return false;
    }
    if (process.platform !== "win32" && actual.mode !== expected.mode) return false;
  }
  return true;
}

async function copyEntry(sourcePath, destinationPath) {
  await fsp.cp(sourcePath, destinationPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

async function removeEntry(filePath, entrySnapshot) {
  if (entrySnapshot.isDirectory && !entrySnapshot.isSymbolicLink) {
    await fsp.rm(filePath, { recursive: true, force: false });
  } else {
    await fsp.unlink(filePath);
  }
}

async function validateSnapshot(filePath, expected, { identityOnly = false } = {}) {
  const current = await snapshot(filePath);
  const valid = identityOnly
    ? identitiesEqual(current, expected)
    : snapshotsEqual(current, expected);
  if (!valid) {
    const error = new Error(`'${filePath}' changed after the operation was prepared.`);
    error.code = "ESTALE";
    throw error;
  }
  return current;
}

async function pathHasIdentity(filePath, expected) {
  return identitiesEqual(await snapshot(filePath), expected);
}

async function restoreMovedPath(fromPath, toPath, expected) {
  if ((await snapshot(toPath)) || !(await pathHasIdentity(fromPath, expected))) return false;
  try {
    await fsp.rename(fromPath, toPath);
    return await pathHasIdentity(toPath, expected);
  } catch {
    return false;
  }
}

async function removeOwnedPath(filePath, expected) {
  if (!(await pathHasIdentity(filePath, expected))) return false;
  try {
    await removeEntry(filePath, expected);
    return (await snapshot(filePath)) === null;
  } catch {
    return false;
  }
}

async function renameWithoutReplacing(
  sourcePath,
  destinationPath,
  sourceSnapshot,
  { identityOnly = false } = {},
) {
  // Node's rename may replace an existing entry, so occupy the name first and
  // replace only the reservation whose identity was checked immediately
  // beforehand. POSIX needs a like-typed directory reservation; Windows can
  // replace a file reservation with a directory but not an empty directory.
  if (
    process.platform !== "win32" &&
    sourceSnapshot.isDirectory &&
    !sourceSnapshot.isSymbolicLink
  ) {
    await fsp.mkdir(destinationPath, { mode: 0o700 });
  } else {
    await fsp.writeFile(destinationPath, "", { flag: "wx", mode: 0o600 });
  }
  const reservationSnapshot = await snapshot(destinationPath);
  try {
    await validateSnapshot(sourcePath, sourceSnapshot, { identityOnly });
    await validateSnapshot(destinationPath, reservationSnapshot);
    await fsp.rename(sourcePath, destinationPath);
  } catch (error) {
    if (
      (await pathHasIdentity(destinationPath, reservationSnapshot)) &&
      !(await removeOwnedPath(destinationPath, reservationSnapshot))
    ) {
      throw new OperationFailure(reasonFor(error), { cleanupPaths: [destinationPath] });
    }
    throw error;
  }
}

let nextEntryId = 1;

function virtualEntry(entrySnapshot, basePath = null) {
  return {
    id: nextEntryId++,
    basePath,
    isDirectory: !!entrySnapshot?.isDirectory,
    isSymbolicLink: !!entrySnapshot?.isSymbolicLink,
    runtimeSnapshot: entrySnapshot,
  };
}

function syntheticEntry(isDirectory) {
  return {
    id: nextEntryId++,
    basePath: null,
    isDirectory,
    isSymbolicLink: false,
    runtimeSnapshot: null,
  };
}

class Planner {
  constructor(operations) {
    this.operations = operations;
    this.actions = [];
    this.steps = [];
    this.baseEntries = new Map();
    this.baselineChecks = new Map();
    this.listingChecks = new Map();
  }

  async build(signal) {
    for (let index = 0; index < this.operations.length; index++) {
      try {
        throwIfAborted(signal);
        const operation = this.normalizeOperation(this.operations[index]);
        if (operation.kind === "create") await this.planCreate(index, operation);
        else if (operation.kind === "rename") await this.planRename(index, operation);
        else await this.planDelete(index, operation);
      } catch (error) {
        if (error instanceof PlanFailure) throw error;
        throw new PlanFailure(index, reasonFor(error));
      }
    }
    return new FileOperationPlan({
      steps: this.steps,
      baselineChecks: [...this.baselineChecks.values()],
      listingChecks: [...this.listingChecks.values()],
    });
  }

  normalizeOperation(operation) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw new Error("Each file operation must be an object.");
    }
    if (!new Set(["create", "rename", "delete"]).has(operation.kind)) {
      throw new Error(`Unknown file operation '${operation.kind}'.`);
    }
    const options = operation.options == null ? {} : operation.options;
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("Operation options must be an object.");
    }
    for (const [key, value] of Object.entries(options)) {
      if (typeof value !== "boolean") throw new Error(`Option '${key}' must be a boolean.`);
    }
    if (operation.kind === "create") {
      return {
        kind: "create",
        path: normalizeAbsolute(operation.path, "path"),
        options: {
          overwrite: options.overwrite === true,
          ignoreIfExists: options.ignoreIfExists === true,
        },
      };
    }
    if (operation.kind === "rename") {
      return {
        kind: "rename",
        oldPath: normalizeAbsolute(operation.oldPath, "oldPath"),
        newPath: normalizeAbsolute(operation.newPath, "newPath"),
        options: {
          overwrite: options.overwrite === true,
          ignoreIfExists: options.ignoreIfExists === true,
        },
      };
    }
    return {
      kind: "delete",
      path: normalizeAbsolute(operation.path, "path"),
      options: {
        recursive: options.recursive === true,
        ignoreIfNotExists: options.ignoreIfNotExists === true,
      },
    };
  }

  async diskEntry(filePath, { identityOnly = false } = {}) {
    const key = pathKey(filePath);
    if (this.baseEntries.has(key)) {
      if (!identityOnly) this.baselineChecks.get(key).identityOnly = false;
      return this.baseEntries.get(key);
    }
    const current = await snapshot(filePath);
    const entry = current ? virtualEntry(current, filePath) : null;
    this.baseEntries.set(key, entry);
    this.baselineChecks.set(key, { path: filePath, entry, identityOnly });
    return entry;
  }

  async lookup(filePath, limit = this.actions.length, options = {}) {
    for (let index = limit - 1; index >= 0; index--) {
      const action = this.actions[index];
      if (action.kind === "create") {
        if (pathsEqual(action.path, filePath)) return action.entry;
        if (pathContains(action.path, filePath)) return null;
        continue;
      }
      if (action.kind === "delete") {
        if (equalOrContained(action.path, filePath)) return null;
        continue;
      }
      if (pathsEqual(action.newPath, filePath)) return action.entry;
      if (pathContains(action.newPath, filePath)) {
        if (!action.entry.isDirectory || action.entry.isSymbolicLink) return null;
        const translated = path.join(action.oldPath, path.relative(action.newPath, filePath));
        const entry = await this.lookup(translated, index, options);
        if (entry) action.movedEntries.set(entry, path.relative(action.newPath, filePath));
        return entry;
      }
      if (equalOrContained(action.oldPath, filePath)) return null;
    }
    return this.diskEntry(filePath, options);
  }

  ancestorPaths(filePath) {
    const paths = [];
    let current = path.dirname(filePath);
    for (;;) {
      paths.push(current);
      const parent = path.dirname(current);
      if (pathsEqual(parent, current)) break;
      current = parent;
    }
    return paths.reverse();
  }

  async prepareParents(filePath) {
    const requirements = [];
    for (const parentPath of this.ancestorPaths(filePath)) {
      let entry = await this.lookup(parentPath, this.actions.length, { identityOnly: true });
      if (entry) {
        if (!entry.isDirectory || entry.isSymbolicLink) {
          throw new Error(`Parent path '${parentPath}' is not a directory.`);
        }
        requirements.push({ path: parentPath, entry, create: false });
        continue;
      }
      if (isRootPath(parentPath)) throw new Error(`Filesystem root '${parentPath}' is missing.`);
      entry = syntheticEntry(true);
      requirements.push({ path: parentPath, entry, create: true });
      this.actions.push({ kind: "create", path: parentPath, entry });
    }
    return requirements;
  }

  async parentBinding(filePath) {
    const parentPath = path.dirname(filePath);
    return {
      path: parentPath,
      entry: await this.lookup(parentPath, this.actions.length, { identityOnly: true }),
    };
  }

  async planCreate(index, operation) {
    if (isRootPath(operation.path)) throw new Error("A filesystem root cannot be created.");
    const existing = await this.lookup(operation.path);
    if (existing && !operation.options.overwrite) {
      if (!operation.options.ignoreIfExists) {
        throw new Error(`Cannot create '${operation.path}': it already exists.`);
      }
      this.steps.push({ index, kind: "create", operation, skip: true, targetEntry: existing });
      return;
    }
    if (existing?.isDirectory && !existing.isSymbolicLink) {
      throw new Error(`Cannot overwrite directory '${operation.path}' with a file.`);
    }
    const parents = await this.prepareParents(operation.path);
    const entry = syntheticEntry(false);
    this.actions.push({ kind: "create", path: operation.path, entry });
    this.steps.push({
      index,
      kind: "create",
      operation,
      parents,
      entry,
      targetEntry: existing,
      targetParent: parents.at(-1),
    });
  }

  async isCaseOnlyRename(oldPath, newPath, source, target) {
    if (
      !source ||
      !target ||
      (source !== target && !identitiesEqual(source.runtimeSnapshot, target.runtimeSnapshot))
    ) {
      return false;
    }
    const oldName = path.basename(oldPath);
    const newName = path.basename(newPath);
    if (oldName === newName || oldName.toLowerCase() !== newName.toLowerCase()) return false;
    const oldParent = await this.lookup(path.dirname(oldPath));
    const newParent = await this.lookup(path.dirname(newPath));
    if (!oldParent || oldParent !== newParent) return false;
    // A virtual create or earlier rename has no directory entry to find during
    // preflight. On a case-folding filesystem both spellings resolve to the
    // same virtual object, which is sufficient to plan the two-hop rename.
    if (source === target) return true;
    let names;
    try {
      names = await fsp.readdir(path.dirname(oldPath));
    } catch {
      return false;
    }
    return names.includes(oldName) && !names.includes(newName);
  }

  async planRename(index, operation) {
    if (isRootPath(operation.oldPath) || isRootPath(operation.newPath)) {
      throw new Error("A filesystem root cannot be renamed or replaced.");
    }
    const source = await this.lookup(operation.oldPath);
    if (!source) throw new Error(`Cannot rename '${operation.oldPath}': it does not exist.`);
    if (operation.oldPath === operation.newPath) {
      this.steps.push({
        index,
        kind: "rename",
        operation,
        skip: true,
        sourceEntry: source,
        targetEntry: source,
      });
      return;
    }
    if (
      source.isDirectory &&
      !source.isSymbolicLink &&
      pathContains(operation.oldPath, operation.newPath)
    ) {
      throw new Error(`Cannot rename directory '${operation.oldPath}' into itself.`);
    }
    if (pathContains(operation.newPath, operation.oldPath)) {
      throw new Error(`Cannot replace an ancestor of '${operation.oldPath}'.`);
    }
    const target = await this.lookup(operation.newPath);
    const caseOnly = await this.isCaseOnlyRename(
      operation.oldPath,
      operation.newPath,
      source,
      target,
    );
    const sameEntryAlias = target === source && !caseOnly;
    if (sameEntryAlias) {
      this.steps.push({
        index,
        kind: "rename",
        operation,
        skip: true,
        sourceEntry: source,
        targetEntry: target,
      });
      return;
    }
    if (target && !caseOnly && !operation.options.overwrite) {
      if (!operation.options.ignoreIfExists) {
        throw new Error(`Cannot rename to '${operation.newPath}': it already exists.`);
      }
      this.steps.push({
        index,
        kind: "rename",
        operation,
        skip: true,
        sourceEntry: source,
        targetEntry: target,
      });
      return;
    }
    const sourceParent = await this.parentBinding(operation.oldPath);
    const parents = await this.prepareParents(operation.newPath);
    const action = {
      kind: "rename",
      oldPath: operation.oldPath,
      newPath: operation.newPath,
      entry: source,
      movedEntries: new Map([[source, ""]]),
    };
    this.actions.push(action);
    this.steps.push({
      index,
      kind: "rename",
      operation,
      parents,
      sourceEntry: source,
      targetEntry: target,
      sourceParent,
      targetParent: parents.at(-1),
      caseOnly,
      action,
    });
  }

  async directoryNames(entry) {
    if (!entry.basePath) return [];
    const key = pathKey(entry.basePath);
    if (this.listingChecks.has(key)) return this.listingChecks.get(key).names;
    const names = await fsp.readdir(entry.basePath);
    names.sort();
    this.listingChecks.set(key, { path: entry.basePath, names });
    return names;
  }

  firstChildName(parentPath, childPath) {
    if (!pathContains(parentPath, childPath)) return null;
    return path.relative(parentPath, childPath).split(path.sep)[0] || null;
  }

  async directoryIsEmpty(directoryPath, entry, limit = this.actions.length) {
    const names = new Set(await this.directoryNames(entry));
    for (let index = 0; index < limit; index++) {
      const action = this.actions[index];
      for (const candidate of [action.path, action.oldPath, action.newPath]) {
        if (!candidate) continue;
        const name = this.firstChildName(directoryPath, candidate);
        if (name) names.add(name);
      }
    }
    for (const name of names) {
      if (await this.lookup(path.join(directoryPath, name), limit)) return false;
    }
    return true;
  }

  async planDelete(index, operation) {
    if (isRootPath(operation.path)) throw new Error("A filesystem root cannot be deleted.");
    const target = await this.lookup(operation.path);
    if (!target) {
      if (!operation.options.ignoreIfNotExists) {
        throw new Error(`Cannot delete '${operation.path}': it does not exist.`);
      }
      this.steps.push({ index, kind: "delete", operation, skip: true, targetEntry: null });
      return;
    }
    if (
      target.isDirectory &&
      !target.isSymbolicLink &&
      !operation.options.recursive &&
      !(await this.directoryIsEmpty(operation.path, target))
    ) {
      throw new Error(`Cannot delete non-empty directory '${operation.path}' without recursive.`);
    }
    const targetParent = await this.parentBinding(operation.path);
    this.actions.push({ kind: "delete", path: operation.path, entry: target });
    this.steps.push({
      index,
      kind: "delete",
      operation,
      targetEntry: target,
      targetParent,
    });
  }
}

class FileOperationPlan {
  #steps;
  #baselineChecks;
  #listingChecks;
  #description;
  #nextIndex = 0;
  #baselineValidated = false;
  #disposed = false;
  #running = false;
  #terminalReason = null;

  constructor({ steps, baselineChecks, listingChecks }) {
    this.#steps = steps;
    this.#baselineChecks = baselineChecks;
    this.#listingChecks = listingChecks;
    this.#description = Object.freeze(
      steps.map((step) => Object.freeze({ status: step.skip ? "skip" : "apply" })),
    );
    Object.freeze(this);
  }

  describe() {
    return this.#description;
  }

  dispose() {
    this.#disposed = true;
  }

  async executeNext({ signal } = {}) {
    if (this.#disposed) {
      return { status: "failed", reason: "The file operation plan was disposed.", effects: [] };
    }
    if (this.#terminalReason) {
      return { status: "failed", reason: this.#terminalReason, effects: [] };
    }
    if (this.#running) {
      return {
        status: "failed",
        reason: "The file operation plan is already executing.",
        effects: [],
      };
    }
    if (this.#nextIndex >= this.#steps.length) return { status: "done", effects: [] };

    this.#running = true;
    try {
      throwIfAborted(signal);
      if (!this.#baselineValidated) {
        await this.validateBaseline(signal);
        this.#baselineValidated = true;
      }
      const step = this.#steps[this.#nextIndex];
      await this.validateStep(step, signal);
      if (step.skip) {
        this.#nextIndex++;
        return { status: "skipped", effects: [] };
      }
      const result = await this.executeStep(step, signal);
      this.#nextIndex++;
      return result;
    } catch (error) {
      const failure =
        error instanceof OperationFailure
          ? error
          : new OperationFailure(reasonFor(error), { partial: false });
      this.#terminalReason = failure.message;
      return {
        status: "failed",
        reason: failure.message,
        effects: failure.effects,
        ...(failure.partial && { partial: true }),
        ...cleanupFields(failure.cleanupPaths),
      };
    } finally {
      this.#running = false;
    }
  }

  async validateBaseline(signal) {
    for (const check of this.#baselineChecks) {
      throwIfAborted(signal);
      await validateSnapshot(check.path, check.entry?.runtimeSnapshot ?? null, {
        identityOnly: check.identityOnly,
      });
    }
    for (const check of this.#listingChecks) {
      throwIfAborted(signal);
      const names = await fsp.readdir(check.path);
      names.sort();
      if (
        names.length !== check.names.length ||
        names.some((name, index) => name !== check.names[index])
      ) {
        const error = new Error(
          `Directory '${check.path}' changed after the operation was prepared.`,
        );
        error.code = "ESTALE";
        throw error;
      }
    }
  }

  async validateBinding(binding) {
    if (!binding) return;
    await validateSnapshot(binding.path, binding.entry?.runtimeSnapshot ?? null, {
      identityOnly: true,
    });
  }

  async validateStep(step, signal) {
    throwIfAborted(signal);
    for (const requirement of step.parents || []) await this.validateBinding(requirement);
    if (step.kind === "create") {
      await validateSnapshot(step.operation.path, step.targetEntry?.runtimeSnapshot ?? null);
    } else if (step.kind === "rename") {
      await validateSnapshot(step.operation.oldPath, step.sourceEntry.runtimeSnapshot);
      await validateSnapshot(step.operation.newPath, step.targetEntry?.runtimeSnapshot ?? null);
    } else {
      await validateSnapshot(step.operation.path, step.targetEntry?.runtimeSnapshot ?? null);
      if (
        step.targetEntry?.isDirectory &&
        !step.targetEntry.isSymbolicLink &&
        !step.operation.options.recursive
      ) {
        const names = await fsp.readdir(step.operation.path);
        if (names.length) {
          throw new Error(
            `Cannot delete non-empty directory '${step.operation.path}' without recursive.`,
          );
        }
      }
    }
    throwIfAborted(signal);
  }

  async materializeParents(step, signal) {
    const created = [];
    for (const requirement of step.parents || []) {
      if (!requirement.create || requirement.entry.runtimeSnapshot) continue;
      throwIfAborted(signal);
      await fsp.mkdir(requirement.path);
      requirement.entry.runtimeSnapshot = await snapshot(requirement.path);
      created.push(requirement);
      const parent = (step.parents || []).find((candidate) =>
        pathsEqual(candidate.path, path.dirname(requirement.path)),
      );
      if (parent?.entry?.runtimeSnapshot) {
        parent.entry.runtimeSnapshot = await snapshot(parent.path);
      }
    }
    return created;
  }

  async cleanupParents(created) {
    const remaining = [];
    for (const requirement of [...created].reverse()) {
      const current = await snapshot(requirement.path);
      if (!identitiesEqual(current, requirement.entry.runtimeSnapshot)) {
        if (current) remaining.push(requirement);
        continue;
      }
      try {
        await fsp.rmdir(requirement.path);
        requirement.entry.runtimeSnapshot = null;
      } catch {
        remaining.push(requirement);
      }
    }
    return remaining.reverse();
  }

  async refreshBindings(...bindings) {
    const seen = new Set();
    for (const binding of bindings) {
      if (!binding?.entry || seen.has(binding.entry)) continue;
      seen.add(binding.entry);
      binding.entry.runtimeSnapshot = await snapshot(binding.path);
    }
  }

  async executeStep(step, signal) {
    let createdParents = [];
    try {
      createdParents = await this.materializeParents(step, signal);
      await this.validateStep(step, signal);
      let result;
      if (step.kind === "create") result = await this.executeCreate(step, signal);
      else if (step.kind === "rename") result = await this.executeRename(step, signal);
      else result = await this.executeDelete(step, signal);
      const parentEffects = createdParents.map((entry) => createEffect(entry.path, true));
      return { ...result, effects: [...parentEffects, ...result.effects] };
    } catch (error) {
      const failure =
        error instanceof OperationFailure
          ? error
          : new OperationFailure(reasonFor(error), { partial: false });
      const remainingParents = await this.cleanupParents(createdParents);
      const parentEffects = remainingParents.map((entry) => createEffect(entry.path, true));
      throw new OperationFailure(failure.message, {
        effects: [...parentEffects, ...failure.effects],
        cleanupPaths: uniquePaths([
          ...failure.cleanupPaths,
          ...remainingParents.map((entry) => entry.path),
        ]),
        partial: parentEffects.length > 0 || failure.partial,
      });
    }
  }

  async executeCreate(step, signal) {
    const { operation, targetEntry, entry } = step;
    const targetSnapshot = targetEntry?.runtimeSnapshot ?? null;
    const stagePath = privateSibling(operation.path, "create");
    const backupPath = targetEntry ? privateSibling(operation.path, "backup") : null;
    let stageSnapshot = null;
    let backupMoved = false;
    let publishedSnapshot = null;
    let committed = false;
    const cleanupPaths = [];
    try {
      throwIfAborted(signal);
      await fsp.writeFile(stagePath, "", { flag: "wx" });
      stageSnapshot = await snapshot(stagePath);
      await validateSnapshot(operation.path, targetEntry?.runtimeSnapshot ?? null);
      if (targetEntry) {
        await fsp.rename(operation.path, backupPath);
        backupMoved = true;
        await validateSnapshot(backupPath, targetEntry.runtimeSnapshot, { identityOnly: true });
        await validateSnapshot(operation.path, null);
      }
      throwIfAborted(signal);
      try {
        await fsp.link(stagePath, operation.path);
      } catch (error) {
        if (!new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]).has(error.code)) throw error;
        await fsp.copyFile(stagePath, operation.path, fs.constants.COPYFILE_EXCL);
      }
      publishedSnapshot = await snapshot(operation.path);
      if (!publishedSnapshot || publishedSnapshot.isDirectory || publishedSnapshot.isSymbolicLink) {
        throw new Error(`Unable to publish created file '${operation.path}'.`);
      }
      committed = true;
      if (!(await removeOwnedPath(stagePath, stageSnapshot))) cleanupPaths.push(stagePath);
      if (backupMoved && !(await removeOwnedPath(backupPath, targetSnapshot))) {
        cleanupPaths.push(backupPath);
      } else if (backupMoved) {
        targetEntry.runtimeSnapshot = null;
      }
      entry.runtimeSnapshot = await snapshot(operation.path);
      await this.refreshBindings(step.targetParent);
      return {
        status: "applied",
        effects: [createEffect(operation.path, false)],
        ...cleanupFields(cleanupPaths),
      };
    } catch (error) {
      if (committed) {
        if (stageSnapshot && (await pathHasIdentity(stagePath, stageSnapshot))) {
          appendCleanupPaths(cleanupPaths, stagePath);
        }
        if (backupMoved && targetSnapshot && (await pathHasIdentity(backupPath, targetSnapshot))) {
          appendCleanupPaths(cleanupPaths, backupPath);
        }
        throw new OperationFailure(reasonFor(error), {
          effects: [createEffect(operation.path, false)],
          cleanupPaths,
        });
      }
      const effects = [];
      const recoveryPaths = [...(error.cleanupPaths || [])];
      if (publishedSnapshot && (await pathHasIdentity(operation.path, publishedSnapshot))) {
        if (!(await removeOwnedPath(operation.path, publishedSnapshot))) {
          effects.push(createEffect(operation.path, false));
          appendCleanupPaths(recoveryPaths, operation.path);
        }
      }
      if (backupMoved && targetEntry) {
        const restored = await restoreMovedPath(
          backupPath,
          operation.path,
          targetEntry.runtimeSnapshot,
        );
        if (!restored) {
          if ((await snapshot(operation.path)) === null) {
            effects.push(deleteEffect(operation.path, targetEntry.isDirectory));
          }
          appendCleanupPaths(recoveryPaths, backupPath);
        }
      }
      if (stageSnapshot && !(await removeOwnedPath(stagePath, stageSnapshot))) {
        appendCleanupPaths(recoveryPaths, stagePath);
      }
      entry.runtimeSnapshot = await snapshot(operation.path);
      await this.refreshBindings(step.targetParent);
      throw new OperationFailure(reasonFor(error), {
        effects,
        cleanupPaths: recoveryPaths,
      });
    }
  }

  async executeRename(step, signal) {
    const { operation, sourceEntry, targetEntry } = step;
    let result;
    if (step.caseOnly) {
      result = await this.executeCaseRename(step, signal);
    } else {
      const sourceParent = await fsp.lstat(path.dirname(operation.oldPath));
      const targetParent = await fsp.lstat(path.dirname(operation.newPath));
      if (sourceParent.dev !== targetParent.dev) {
        result = await this.executeCrossDeviceRename(step, signal);
      } else {
        try {
          result = await this.executeLocalRename(step, signal);
        } catch (error) {
          if (error.code !== "EXDEV") throw error;
          result = await this.executeCrossDeviceRename(step, signal);
        }
      }
    }
    try {
      for (const [entry, relativePath] of step.action.movedEntries) {
        const movedPath = relativePath
          ? path.join(operation.newPath, relativePath)
          : operation.newPath;
        entry.runtimeSnapshot = await snapshot(movedPath);
      }
      if (targetEntry && targetEntry !== sourceEntry) targetEntry.runtimeSnapshot = null;
      await this.refreshBindings(
        { path: path.dirname(operation.oldPath), entry: step.sourceParent?.entry },
        { path: path.dirname(operation.newPath), entry: step.targetParent?.entry },
      );
      return result;
    } catch (error) {
      throw new OperationFailure(reasonFor(error), {
        effects: result.effects,
        cleanupPaths: result.cleanupPaths || [],
      });
    }
  }

  async executeCaseRename(step, signal) {
    const { operation, sourceEntry } = step;
    const temporaryPath = privateSibling(operation.oldPath, "case");
    let movedToTemporary = false;
    try {
      throwIfAborted(signal);
      await fsp.rename(operation.oldPath, temporaryPath);
      movedToTemporary = true;
      const temporarySnapshot = await validateSnapshot(temporaryPath, sourceEntry.runtimeSnapshot, {
        identityOnly: true,
      });
      await validateSnapshot(operation.newPath, null);
      throwIfAborted(signal);
      await renameWithoutReplacing(temporaryPath, operation.newPath, temporarySnapshot);
      movedToTemporary = false;
      await validateSnapshot(operation.newPath, sourceEntry.runtimeSnapshot, {
        identityOnly: true,
      });
      const names = await fsp.readdir(path.dirname(operation.newPath));
      if (!names.includes(path.basename(operation.newPath))) {
        throw new Error(`The filesystem did not apply the requested filename case.`);
      }
      return {
        status: "applied",
        effects: [renameEffect(operation.oldPath, operation.newPath, sourceEntry.isDirectory)],
      };
    } catch (error) {
      const cleanupPaths = [...(error.cleanupPaths || [])];
      const effects = [];
      if (movedToTemporary) {
        if (
          !(await restoreMovedPath(temporaryPath, operation.oldPath, sourceEntry.runtimeSnapshot))
        ) {
          appendCleanupPaths(cleanupPaths, temporaryPath);
          if ((await snapshot(operation.oldPath)) === null) {
            effects.push(deleteEffect(operation.oldPath, sourceEntry.isDirectory));
          }
        }
      } else if (await pathHasIdentity(operation.newPath, sourceEntry.runtimeSnapshot)) {
        if (
          !(await restoreMovedPath(
            operation.newPath,
            operation.oldPath,
            sourceEntry.runtimeSnapshot,
          ))
        ) {
          effects.push(renameEffect(operation.oldPath, operation.newPath, sourceEntry.isDirectory));
          appendCleanupPaths(cleanupPaths, operation.newPath);
        }
      }
      throw new OperationFailure(reasonFor(error), { effects, cleanupPaths });
    }
  }

  async executeLocalRename(step, signal) {
    const { operation, sourceEntry, targetEntry } = step;
    const targetSnapshot = targetEntry?.runtimeSnapshot ?? null;
    const backupPath = targetEntry ? privateSibling(operation.newPath, "backup") : null;
    let backupMoved = false;
    let moved = false;
    try {
      await validateSnapshot(operation.oldPath, sourceEntry.runtimeSnapshot);
      await validateSnapshot(operation.newPath, targetEntry?.runtimeSnapshot ?? null);
      if (targetEntry) {
        await fsp.rename(operation.newPath, backupPath);
        backupMoved = true;
        await validateSnapshot(backupPath, targetEntry.runtimeSnapshot, { identityOnly: true });
        await validateSnapshot(operation.newPath, null);
      }
      throwIfAborted(signal);
      await renameWithoutReplacing(
        operation.oldPath,
        operation.newPath,
        sourceEntry.runtimeSnapshot,
        {
          // Moving the other name of a hard-linked file changes this inode's
          // ctime even though the source entry and its contents remain ours.
          identityOnly: identitiesEqual(sourceEntry.runtimeSnapshot, targetSnapshot),
        },
      );
      moved = true;
      await validateSnapshot(operation.newPath, sourceEntry.runtimeSnapshot, {
        identityOnly: true,
      });
      const cleanupPaths = [];
      if (backupMoved && !(await removeOwnedPath(backupPath, targetSnapshot))) {
        cleanupPaths.push(backupPath);
      }
      return {
        status: "applied",
        effects: [renameEffect(operation.oldPath, operation.newPath, sourceEntry.isDirectory)],
        ...cleanupFields(cleanupPaths),
      };
    } catch (error) {
      const effects = [];
      const cleanupPaths = [...(error.cleanupPaths || [])];
      if (moved && (await pathHasIdentity(operation.newPath, sourceEntry.runtimeSnapshot))) {
        if (
          !(await restoreMovedPath(
            operation.newPath,
            operation.oldPath,
            sourceEntry.runtimeSnapshot,
          ))
        ) {
          effects.push(renameEffect(operation.oldPath, operation.newPath, sourceEntry.isDirectory));
          appendCleanupPaths(cleanupPaths, operation.newPath);
        }
      }
      if (backupMoved && targetEntry) {
        if (!(await restoreMovedPath(backupPath, operation.newPath, targetSnapshot))) {
          appendCleanupPaths(cleanupPaths, backupPath);
          if ((await snapshot(operation.newPath)) === null) {
            effects.push(deleteEffect(operation.newPath, targetEntry.isDirectory));
          }
        }
      }
      if (error.code === "EXDEV" && effects.length === 0 && cleanupPaths.length === 0) {
        sourceEntry.runtimeSnapshot = await snapshot(operation.oldPath);
        if (targetEntry) targetEntry.runtimeSnapshot = await snapshot(operation.newPath);
        throw error;
      }
      throw new OperationFailure(reasonFor(error), { effects, cleanupPaths });
    }
  }

  async executeCrossDeviceRename(step, signal) {
    const { operation, sourceEntry, targetEntry } = step;
    const targetSnapshot = targetEntry?.runtimeSnapshot ?? null;
    const tombstonePath = privateSibling(operation.oldPath, "move");
    const stagingPath = privateSibling(operation.newPath, "copy");
    const backupPath = targetEntry ? privateSibling(operation.newPath, "backup") : null;
    let tombstoneMoved = false;
    let backupMoved = false;
    let stagingSnapshot = null;
    let publishedSnapshot = null;
    let committed = false;
    const cleanupPaths = [];
    try {
      throwIfAborted(signal);
      await fsp.rename(operation.oldPath, tombstonePath);
      tombstoneMoved = true;
      await validateSnapshot(tombstonePath, sourceEntry.runtimeSnapshot, { identityOnly: true });
      const before = await treeManifest(tombstonePath);
      throwIfAborted(signal);
      await copyEntry(tombstonePath, stagingPath);
      stagingSnapshot = await snapshot(stagingPath);
      if (!stagingSnapshot) throw new Error(`Unable to stage '${operation.oldPath}'.`);
      const [after, copied] = await Promise.all([
        treeManifest(tombstonePath),
        treeManifest(stagingPath),
      ]);
      if (!manifestsEqual(before, after) || !manifestsEqual(after, copied)) {
        const error = new Error(`'${operation.oldPath}' changed while it was being copied.`);
        error.code = "ESTALE";
        throw error;
      }
      await validateSnapshot(operation.newPath, targetEntry?.runtimeSnapshot ?? null);
      if (targetEntry) {
        await fsp.rename(operation.newPath, backupPath);
        backupMoved = true;
        await validateSnapshot(backupPath, targetSnapshot, { identityOnly: true });
        await validateSnapshot(operation.newPath, null);
      }
      throwIfAborted(signal);
      await renameWithoutReplacing(stagingPath, operation.newPath, stagingSnapshot);
      publishedSnapshot = stagingSnapshot;
      publishedSnapshot = await validateSnapshot(operation.newPath, publishedSnapshot, {
        identityOnly: true,
      });
      const [frozenAtCommit, publishedAtCommit] = await Promise.all([
        treeManifest(tombstonePath),
        treeManifest(operation.newPath),
      ]);
      if (
        !manifestsEqual(after, frozenAtCommit) ||
        !manifestsEqual(frozenAtCommit, publishedAtCommit)
      ) {
        const error = new Error(`'${operation.oldPath}' changed before the move committed.`);
        error.code = "ESTALE";
        throw error;
      }
      await validateSnapshot(operation.newPath, publishedSnapshot, { identityOnly: true });
      committed = true;
      if (!(await removeOwnedPath(tombstonePath, sourceEntry.runtimeSnapshot))) {
        cleanupPaths.push(tombstonePath);
      } else {
        tombstoneMoved = false;
      }
      if (backupMoved && !(await removeOwnedPath(backupPath, targetSnapshot))) {
        cleanupPaths.push(backupPath);
      } else if (backupMoved) {
        backupMoved = false;
      }
      return {
        status: "applied",
        effects: [renameEffect(operation.oldPath, operation.newPath, sourceEntry.isDirectory)],
        ...cleanupFields(cleanupPaths),
      };
    } catch (error) {
      if (committed) {
        appendCleanupPaths(cleanupPaths, error.cleanupPaths || []);
        if (tombstoneMoved) appendCleanupPaths(cleanupPaths, tombstonePath);
        if (backupMoved) appendCleanupPaths(cleanupPaths, backupPath);
        throw new OperationFailure(reasonFor(error), {
          effects: [renameEffect(operation.oldPath, operation.newPath, sourceEntry.isDirectory)],
          cleanupPaths,
        });
      }
      const recoveryPaths = [...(error.cleanupPaths || [])];
      const effects = [];
      if (publishedSnapshot && (await pathHasIdentity(operation.newPath, publishedSnapshot))) {
        if (!(await removeOwnedPath(operation.newPath, publishedSnapshot))) {
          effects.push(createEffect(operation.newPath, sourceEntry.isDirectory));
          appendCleanupPaths(recoveryPaths, operation.newPath);
        }
      }
      if (backupMoved && targetEntry) {
        if (!(await restoreMovedPath(backupPath, operation.newPath, targetSnapshot))) {
          appendCleanupPaths(recoveryPaths, backupPath);
          if ((await snapshot(operation.newPath)) === null) {
            effects.push(deleteEffect(operation.newPath, targetEntry.isDirectory));
          }
        }
      }
      const remainingStage = await snapshot(stagingPath);
      const ownedStage = stagingSnapshot || remainingStage;
      if (ownedStage && remainingStage && !(await removeOwnedPath(stagingPath, ownedStage))) {
        appendCleanupPaths(recoveryPaths, stagingPath);
      }
      if (tombstoneMoved) {
        if (
          !(await restoreMovedPath(tombstonePath, operation.oldPath, sourceEntry.runtimeSnapshot))
        ) {
          appendCleanupPaths(recoveryPaths, tombstonePath);
          if ((await snapshot(operation.oldPath)) === null) {
            effects.push(deleteEffect(operation.oldPath, sourceEntry.isDirectory));
          }
        }
      }
      throw new OperationFailure(reasonFor(error), { effects, cleanupPaths: recoveryPaths });
    }
  }

  async executeDelete(step, signal) {
    const { operation, targetEntry } = step;
    const targetSnapshot = targetEntry.runtimeSnapshot;
    const tombstonePath = privateSibling(operation.path, "delete");
    const before =
      targetEntry.isDirectory && !targetEntry.isSymbolicLink && operation.options.recursive
        ? await treeManifest(operation.path)
        : null;
    let moved = false;
    let committed = false;
    try {
      throwIfAborted(signal);
      await fsp.rename(operation.path, tombstonePath);
      moved = true;
      await validateSnapshot(tombstonePath, targetSnapshot, { identityOnly: true });
      if (targetEntry.isDirectory && !targetEntry.isSymbolicLink) {
        if (operation.options.recursive) {
          await fsp.rm(tombstonePath, { recursive: true, force: false });
        } else {
          await fsp.rmdir(tombstonePath);
        }
      } else {
        await fsp.unlink(tombstonePath);
      }
      moved = false;
      committed = true;
      targetEntry.runtimeSnapshot = null;
      await this.refreshBindings(step.targetParent);
      return {
        status: "applied",
        effects: [deleteEffect(operation.path, targetEntry.isDirectory)],
      };
    } catch (error) {
      if (committed) {
        throw new OperationFailure(reasonFor(error), {
          effects: [deleteEffect(operation.path, targetEntry.isDirectory)],
          cleanupPaths: error.cleanupPaths || [],
        });
      }
      const effects = [];
      const cleanupPaths = [...(error.cleanupPaths || [])];
      if (moved) {
        if (!(await restoreMovedPath(tombstonePath, operation.path, targetSnapshot))) {
          appendCleanupPaths(cleanupPaths, tombstonePath);
          if ((await snapshot(operation.path)) === null) {
            effects.push(deleteEffect(operation.path, targetEntry.isDirectory));
          }
        } else if (before) {
          try {
            const after = await treeManifest(operation.path);
            if (!manifestsEqual(before, after)) {
              for (const [relativePath, record] of before) {
                if (!relativePath || after.has(relativePath)) continue;
                effects.push(
                  deleteEffect(
                    path.join(operation.path, ...relativePath.split("/")),
                    record.isDirectory,
                  ),
                );
              }
            }
          } catch {
            appendCleanupPaths(cleanupPaths, operation.path);
          }
        }
      }
      targetEntry.runtimeSnapshot = await snapshot(operation.path);
      await this.refreshBindings(step.targetParent);
      throw new OperationFailure(reasonFor(error), { effects, cleanupPaths });
    }
  }
}

module.exports = class FileOperationsExecutor {
  async prepare(operations, { signal } = {}) {
    if (!Array.isArray(operations)) {
      return {
        status: "failed",
        failedOperation: 0,
        reason: "File operations must be an array.",
      };
    }
    try {
      throwIfAborted(signal);
      const plan = await new Planner(operations).build(signal);
      return { status: "ready", plan };
    } catch (error) {
      return {
        status: "failed",
        failedOperation: error instanceof PlanFailure ? error.index : 0,
        reason: reasonFor(error),
      };
    }
  }
};
