# file-operations.executor

Preflight and execute ordered filesystem resource operations without depending on a user interface or protocol.

|             |                                                                    |
| ----------- | ------------------------------------------------------------------ |
| Version     | `1.0.0`                                                            |
| Provided by | `provideFileOperationsExecutor()`                                  |
| Consumed by | Workspace-edit coordinators and packages that mutate project paths |
| Owner       | `file-operations`                                                  |

## Registration

Consume `file-operations.executor` at `^1.0.0`. The service object may be retained until the consumer is deactivated; dispose every lifecycle subscription when that consumer deactivates.

## Contract

```ts
type FileOperation =
  | {
      kind: "create";
      path: string;
      options?: { overwrite?: boolean; ignoreIfExists?: boolean };
    }
  | {
      kind: "rename";
      oldPath: string;
      newPath: string;
      options?: { overwrite?: boolean; ignoreIfExists?: boolean };
    }
  | {
      kind: "delete";
      path: string;
      options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
    };

type FileEffect =
  | { kind: "create"; path: string; isDirectory: boolean }
  | { kind: "rename"; oldPath: string; newPath: string; isDirectory: boolean }
  | { kind: "delete"; path: string; isDirectory: boolean };

type FileInspection = {
  readonly path: string;
  readonly status: "file" | "directory" | "missing";
};

type StepResult =
  | {
      status: "applied";
      effects: FileEffect[];
      cleanupPaths?: string[];
    }
  | { status: "skipped"; effects: [] }
  | {
      status: "failed";
      reason: string;
      effects: FileEffect[];
      partial?: boolean;
      cleanupPaths?: string[];
    }
  | { status: "done"; effects: [] };

type FileOperationPlan = {
  describe(): ReadonlyArray<Readonly<{ status: "apply" | "skip" }>>;
  executeNext(options?: { signal?: AbortSignal }): Promise<StepResult>;
  dispose(): void;
};

type FileEventRoot = { readonly path: string; readonly recursive: boolean };

type WillExecuteStepEvent = {
  readonly id: number;
  readonly operationIndex: number;
  readonly operation: Readonly<FileOperation>;
};

type DidExecuteStepEvent = WillExecuteStepEvent & {
  readonly result: Readonly<StepResult>;
  readonly eventTrace: Readonly<{
    internalRoots: ReadonlyArray<Readonly<FileEventRoot>>;
    coveredRoots: ReadonlyArray<Readonly<FileEventRoot>>;
  }>;
};

type FileOperationsExecutor = {
  inspect(
    paths: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<ReadonlyArray<Readonly<FileInspection>>>;
  onWillExecuteStep(callback: (event: WillExecuteStepEvent) => void): { dispose(): void };
  onDidExecuteStep(callback: (event: DidExecuteStepEvent) => void | PromiseLike<void>): {
    dispose(): void;
  };
  prepare(
    operations: readonly FileOperation[],
    options?: { signal?: AbortSignal },
  ): Promise<
    | { status: "ready"; plan: FileOperationPlan }
    | { status: "failed"; failedOperation: number; reason: string }
  >;
};
```

Every path must be absolute. `prepare()` reads but never mutates the filesystem. It simulates the complete sequence in input order, including paths produced or removed by earlier steps, and returns the zero-based operation index when preflight fails. `overwrite` takes precedence over the corresponding `ignore` option.

`inspect()` validates every input before reading, preserves input order and returns a frozen array of frozen entries. It uses `lstat`: real directories are `directory`, regular files and symbolic links, including dangling links and links to directories, are `file`, and `ENOENT` or `ENOTDIR` is `missing`. Invalid inputs, non-missing filesystem errors and cancellation reject the promise; cancellation uses an `AbortError` with code `ABORT_ERR`. Duplicate paths remain duplicate results.

The plan is opaque and tied to the state observed by `prepare()`. `describe()` returns a frozen array, aligned with the input operations, whose frozen entries say only whether preflight will apply or skip each operation; it exposes no filesystem snapshots and is safe for an orchestrator to retain. The first `executeNext()` revalidates every baseline path read during preflight; each call then revalidates the next step immediately before mutation. A changed path fails rather than silently replanning under the caller. Calls after every step return `done`, while calls after `dispose()` or a terminal failure return `failed`.

Create makes an empty file and creates missing parent directories. Rename preserves files, directories and symbolic links, including a case-only rename; crossing devices uses a staged copy and does not remove the source until the destination is complete. Delete treats a symbolic link as a leaf, removes an empty directory without `recursive`, and requires `recursive` for a non-empty directory.

Effects describe durable logical changes, not private staging, backup or tombstone paths. A failed step sets `partial` only when at least one logical effect remains after recovery. A successful or failed step may carry `cleanupPaths` when private recovery entries could not be removed; every known remaining path is reported.

Every actual step emits `onWillExecuteStep` synchronously before its first filesystem call and emits `onDidExecuteStep` after execution and recovery have settled. The did listeners are awaited before `executeNext()` resolves. Listener exceptions and rejected promises are logged and never alter the step result; will listeners must establish their gate synchronously because returned promises are deliberately not awaited. Disposing a subscription is idempotent. Calls that return `done`, reject concurrent execution, or target a disposed or terminal plan do not represent a step and emit neither event.

Lifecycle payloads and their nested public data are frozen. `eventTrace.internalRoots` names the exact private stage, backup, tombstone and case-temporary roots claimed by the executor; `recursive` means descendants belong to that root too. `eventTrace.coveredRoots` names logical roots whose raw create/delete traffic was either replaced by the reported durable effects or safely rolled back. A path found to have been taken over by an external writer is not covered. A watcher bridge should buffer while a step is active, publish durable effects first, discard internal traffic, prevent covered create/delete events from being inferred as separate external file operations, project the effects into canonical watched-file events, and replay every remaining external event in its original order. In particular, an `updated` event beneath a recursive covered root can be external and must not be dropped merely because its path is contained by that root. The trace is not a time fence: never retain a covered logical root behind a timeout after the step settles; a late duplicate is preferable to suppressing a later external change.

## Minimal example

```js
async consumeFileOperationsExecutor(executor) {
  const prepared = await executor.prepare([
    { kind: "create", path: target },
    { kind: "rename", oldPath: target, newPath: destination },
  ]);
  if (prepared.status === "failed") throw new Error(prepared.reason);

  try {
    await prepared.plan.executeNext();
    await prepared.plan.executeNext();
  } finally {
    prepared.plan.dispose();
  }
}
```

## Limits

The executor provides abort-on-failure ordering rather than a batch-wide undo transaction: a later step can fail after earlier steps committed. It preserves regular files, directories and symbolic links during cross-device rename, including file modes and timestamps where the platform permits, but does not promise ACL, extended-attribute, alternate-stream, sparse-file or hard-link-topology fidelity. Cancellation is checked around filesystem calls; an operating-system call already in progress cannot be interrupted portably.

Filesystem path replacement cannot be a true compare-and-swap through Node's portable APIs. The executor verifies identity immediately before and after every rename and restores only entries it can still identify; an adversarial process can still win the narrow interval between those checks, in which case the operation fails and reports any remaining logical effect or private recovery path.

## Teardown

Call `dispose()` on every prepared plan, including a fully executed or failed plan. Disposal is idempotent and creates no filesystem changes.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. Breaking changes require a new service name.
