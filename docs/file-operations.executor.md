# file-operations.executor

Preflight and execute ordered filesystem resource operations without depending on a user interface or protocol.

|             |                                                                    |
| ----------- | ------------------------------------------------------------------ |
| Version     | `1.0.0`                                                            |
| Provided by | `provideFileOperationsExecutor()`                                  |
| Consumed by | Workspace-edit coordinators and packages that mutate project paths |
| Owner       | `file-operations`                                                  |

## Registration

Consume `file-operations.executor` at `^1.0.0`. The service object is stateless and may be retained until the consumer is deactivated.

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

type StepResult =
  | { status: "applied"; effects: FileEffect[]; cleanupPath?: string }
  | { status: "skipped"; effects: [] }
  | {
      status: "failed";
      reason: string;
      effects: FileEffect[];
      partial?: boolean;
      cleanupPath?: string;
    }
  | { status: "done"; effects: [] };

type FileOperationPlan = {
  executeNext(options?: { signal?: AbortSignal }): Promise<StepResult>;
  dispose(): void;
};

type FileOperationsExecutor = {
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

The plan is opaque and tied to the state observed by `prepare()`. The first `executeNext()` revalidates every baseline path read during preflight; each call then revalidates the next step immediately before mutation. A changed path fails rather than silently replanning under the caller. Calls after every step return `done`, while calls after `dispose()` or a terminal failure return `failed`.

Create makes an empty file and creates missing parent directories. Rename preserves files, directories and symbolic links, including a case-only rename; crossing devices uses a staged copy and does not remove the source until the destination is complete. Delete treats a symbolic link as a leaf, removes an empty directory without `recursive`, and requires `recursive` for a non-empty directory.

Effects describe durable logical changes, not private staging, backup or tombstone paths. A failed step sets `partial` only when at least one logical effect remains after recovery. A successful step may carry `cleanupPath` when its visible result committed but a private recovery entry could not be removed.

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
