# Source storage and review

Lillia's source store preserves the code behind an agent task so the service can check that the submission, reviewer approval and final validation results refer to the candidate being accepted. It also records which revision became the accepted version.

This example includes the prototype's **original source store**, a runnable storage demonstration, and an [annotated review walkthrough](docs/review-sequence.md). It exposes the persistence mechanism and explains how the application uses it. The complete orchestrator and its provider integrations remain private.

## From source history to agent history

Lillia's broader goal is to connect code to the work that produced it: the goal, agent turn, review and validation. The current application retains source revisions and records which candidate its review evidence covers. This preview exposes the storage part of that connection; the walkthrough explains the surrounding application logic.

Planned additions include a "Why is this here?" view linking accepted lines to their originating conversations, plus snapshots after file-changing tool calls so users can inspect, restore or branch from retained intermediate steps. Those features are not implemented yet. This example demonstrates the revision and acceptance mechanisms they would build on.

## How revisions support review

Suppose an author produces revision A and a reviewer approves it. If further work produces revision B, the approval still covers A. Lillia needs to retain both versions and identify which one was read, tested and submitted for acceptance. A file path or a message saying “approved” cannot establish that by itself.

The store gives retained file bytes and revisions content-derived identities. The surrounding service checks agent execution records, associates review and validation evidence with those identities, and decides whether a candidate can be accepted. The store then applies the requested source update only if the target is still the version the service expected.

Keeping this bounded source model in the workflow's SQLite database lets the demonstrated project flow record source acceptance and task completion in one transaction. The store also protects the reference update and its history event with a savepoint, so those two records stay consistent even when a caller catches a write error. Here a **reference** is a named pointer to a revision, such as the current accepted version.

The example exercises the storage mechanisms behind those decisions:

- **Retained file and revision identities** let a reviewer read an exact candidate while earlier versions remain available. A file ID depends on its bytes; a revision ID also includes the repository, ordered parents, edits and metadata.
- **An expected target and generation** reject updates based on an outdated accepted version. The generation counts updates to the reference.
- **A reference update and its history event** commit together. If the event cannot be written, the reference stays at its previous revision.

## Storage choice and Git

This is a custom source-versioning layer built on SQLite. Keeping revisions and workflow records together gives the prototype one place to record source acceptance and task completion. The tradeoff is maintaining its own revision format, reconstruction logic and Git interoperability.

Git can also preserve exact source versions, and agent-history features could be built around it. An alternative design could record the accepted Git commit ID alongside review and completion records in SQLite, with explicit recovery for Git reference and checkout updates. A custom revision format is not required for that design.

The native store is an experiment in supporting this workflow. [Source control for agent workflows](../../docs/source-control.md) explains the broader direction, isolated optimization work, and the planned persistent-Git and real-task workflow comparisons. Those comparisons remain future work; this preview demonstrates the original implementation, not an established advantage over Git.

## Run it

Use **Node.js 24.22.2 or newer**. No package installation, account, API key or network connection is needed.

From the repository root:

```sh
cd examples/source-and-review
npm run demo
npm test
```

The example uses Node's built-in SQLite module. Every run creates its own temporary, file-backed database. The demo closes it and removes its directory in a `finally` block; tests register equivalent cleanup.

The demo stores a synthetic two-file change and checks five behaviors:

1. Retaining a candidate revision leaves the integration reference unchanged.
2. Advancing that reference records one event; retrying the same operation returns that event.
3. A new request based on the previous target and generation is rejected.
4. Reopening SQLite preserves both revisions and their original bytes.
5. An injected history-write failure leaves the reference and history unchanged, even when the outer transaction catches the error and commits.

It finishes with `Verified 5 files, 3 revisions, 2 events.` and confirms temporary database cleanup. Each step has assertions; an unexpected result exits with an error. The source strings are illustrative fixtures, not executed tests or output from agents. The runnable behavior here is storage, not the application's review gate.

## Read the implementation

| File | Purpose |
| --- | --- |
| [demo.mjs](demo.mjs) | A complete example, including stale updates, retries and an injected failure. |
| [support/database.mjs](support/database.mjs) | Temporary SQLite setup, synchronous transactions, reopening and cleanup. |
| [src/native-store.mjs](src/native-store.mjs) | Original content identities, revision storage, integrity checks and conditional reference updates. |
| [test/native-store.test.mjs](test/native-store.test.mjs) | Named failure scenarios and original identity vectors. |
| [fixtures/change.mjs](fixtures/change.mjs) | Synthetic source text for the demo. |
| [docs/review-sequence.md](docs/review-sequence.md) | Exact internal excerpts and the checks surrounding review acceptance. |

The adapter uses a file-backed database with foreign keys enabled, WAL journaling and FULL synchronization. Call `putFile` **before** the revision transaction: it commits the bytes independently. Call `acceptRevision` and `advanceRef` **inside** `transaction(callback)`. That callback is synchronous and must not start asynchronous work. Keeping bytes before accepting a revision allows a failed revision transaction to leave retained bytes, but never a revision that depends on uncommitted bytes.

## Source and verification

The source snapshot is `a09c83bd79b844fbab28f90e2bff9ca50de7e7a3`.

- `src/native-store.mjs` is an unchanged copy of the original file. Its SHA-256 is `2caa0a1987a5897c31d4553230789700c3aab2ad9318d000f654aaea0c37b2ad`. The historical `scion-native` hash framing remains intact because changing it would change stored identities.
- The tests adapt four original core scenarios: identities/reopen/grants; first-parent deltas and reference history; invalid inputs/corruption; and failure during history insertion. They retain the identity vectors and add named cases, checks for unchanged state and adapter cleanup coverage. The original application-level editing and process-kill tests are excluded.
- The adapter, demo and synthetic fixtures are example code. The review document identifies exact excerpts by source file and line range within the snapshot.

Verified on **Node.js v24.22.2, macOS arm64**. Other environments have not been verified for this preview.

## Limits

This is a bounded prototype store: at most 1,024 revisions, 256 ancestry levels and 64 MiB of retained raw file bytes, with additional per-file/tree limits in the implementation. It has no garbage collection. Multiple parents are retained, but edits describe the result relative to the first parent; the store does not resolve merge conflicts automatically.

The store checks bytes and update consistency. It does not authenticate agents or authorize a source change. The [walkthrough](docs/review-sequence.md) explains the additional evidence checks used by the application. This example does not establish production scalability, power-loss durability or general autonomous delivery.

The example package is private and marked `UNLICENSED`; no open-source license has been assigned to this preview.

[Return to the Lillia overview](../../README.md)
