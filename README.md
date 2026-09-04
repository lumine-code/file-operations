# file-operations

Executes ordered filesystem changes through preflighted plans.

## Features

- **Whole-plan preflight**: validates an ordered create, rename and delete sequence against a virtual filesystem before anything changes on disk.
- **Race detection**: records filesystem identities and directory listings, then rejects paths changed between planning and execution.
- **Safe replacement**: stages creates and backs up overwritten entries so a failed publication can restore the original path.
- **Cross-device rename**: copies through private staging paths and removes the source only after the destination has been published safely.
- **Symlink fidelity**: treats symbolic links as leaf entries and never follows the final link during rename, overwrite or delete.
- **Exact outcomes**: every step reports whether it applied, skipped or failed and lists only logical effects that remain visible.

## Installation

To install `file-operations` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/file-operations`.

This package is infrastructure for other packages and has no commands or interface of its own.

## Services

- [`file-operations.executor`](docs/file-operations.executor.md): provided to preflight an ordered sequence and execute it one step at a time.

## Usage

Consumers pass absolute paths and retain the returned opaque plan while they interleave filesystem steps with their own work. Always dispose the plan when the operation finishes or is abandoned.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
