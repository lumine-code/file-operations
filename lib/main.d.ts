export interface CreateOperation {
  kind: "create";
  path: string;
  options?: {
    overwrite?: boolean;
    ignoreIfExists?: boolean;
  };
}

export interface RenameOperation {
  kind: "rename";
  oldPath: string;
  newPath: string;
  options?: {
    overwrite?: boolean;
    ignoreIfExists?: boolean;
  };
}

export interface DeleteOperation {
  kind: "delete";
  path: string;
  options?: {
    recursive?: boolean;
    ignoreIfNotExists?: boolean;
  };
}

export type FileOperation = CreateOperation | RenameOperation | DeleteOperation;

export interface FileInspection {
  readonly path: string;
  readonly status: "file" | "directory" | "missing";
}

export interface CreateEffect {
  kind: "create";
  path: string;
  isDirectory: boolean;
}

export interface RenameEffect {
  kind: "rename";
  oldPath: string;
  newPath: string;
  isDirectory: boolean;
}

export interface DeleteEffect {
  kind: "delete";
  path: string;
  isDirectory: boolean;
}

export type FileEffect = CreateEffect | RenameEffect | DeleteEffect;

export type StepResult =
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

export interface FileEventRoot {
  readonly path: string;
  readonly recursive: boolean;
}

export interface FileOperationEventTrace {
  readonly internalRoots: ReadonlyArray<Readonly<FileEventRoot>>;
  readonly coveredRoots: ReadonlyArray<Readonly<FileEventRoot>>;
}

export interface WillExecuteStepEvent {
  readonly id: number;
  readonly operationIndex: number;
  readonly operation: Readonly<FileOperation>;
}

export interface DidExecuteStepEvent extends WillExecuteStepEvent {
  readonly result: Readonly<StepResult>;
  readonly eventTrace: Readonly<FileOperationEventTrace>;
}

export interface Disposable {
  dispose(): void;
}

export interface FileOperationPlan {
  describe(): ReadonlyArray<Readonly<{ status: "apply" | "skip" }>>;
  executeNext(options?: { signal?: AbortSignal }): Promise<StepResult>;
  dispose(): void;
}

export type PrepareResult =
  | { status: "ready"; plan: FileOperationPlan }
  | { status: "failed"; failedOperation: number; reason: string };

export interface FileOperationsExecutor {
  inspect(
    paths: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<ReadonlyArray<Readonly<FileInspection>>>;
  onWillExecuteStep(callback: (event: WillExecuteStepEvent) => void): Disposable;
  onDidExecuteStep(callback: (event: DidExecuteStepEvent) => void | PromiseLike<void>): Disposable;
  prepare(
    operations: readonly FileOperation[],
    options?: { signal?: AbortSignal },
  ): Promise<PrepareResult>;
}

export function provideFileOperationsExecutor(): FileOperationsExecutor;
