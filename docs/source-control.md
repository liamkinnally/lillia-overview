# Source control for agent workflows

I am building Lillia to make agent work easier to inspect and recover. When several coding threads overlap, I want to understand which goal a change served, what an agent tried along the way, and which review and checks support the accepted result. That context can be spread across source history, conversations and terminal output.

The intended experience is concrete: select an accepted line and open the agent turn and review behind it; inspect an unsuccessful intermediate attempt; or restore a thread to a retained step without changing accepted code. These interactions are planned. The prototype currently retains source versions and workflow records that they would build on.

There are two decisions here: how to make that workflow useful, and which storage backend should support it. Git already provides source history. Lillia adds the task, agent and evidence relationships around that history. Those relationships are the reason I want to build the tool, and the tool could use a Git backend if that proves to be the better engineering choice.

## What exists today

The prototype has a custom versioned-source layer built on SQLite. SQLite supplies the database machinery; Lillia defines the file identities, revisions and acceptance rules above it.

- **Exact retained versions.** File contents and revisions have content-derived identities. Earlier versions remain available when an agent produces a new candidate.
- **Review tied to a candidate.** The surrounding service associates review and validation evidence with the revision being considered. Approval of revision A does not automatically approve a later revision B.
- **Conditional acceptance.** An expected target revision and update counter prevent an outdated request from replacing a target that has moved.
- **Consistent acceptance records.** The source reference and its history event update together. The demonstrated project flow also records source acceptance and task completion in one SQLite transaction.

The [runnable source example](../examples/source-and-review/README.md) exposes the original store, its limits and failure tests. The [review walkthrough](../examples/source-and-review/docs/review-sequence.md) explains the service-side checks around it. The storage layer alone does not decide whether an agent's work is correct or authorized.

## The interactions I want to build

The next work would use those records to answer questions people have while supervising agents:

- **Why is this line here?** Follow an accepted line to the revision, goal, originating agent turn and review decisions behind it. Imported code and missing attribution should be identified explicitly. Unaccepted work would show its owning thread and retained step.
- **What happened between the start and the final submission?** Retain a private snapshot after each file-changing tool call, with a diff for that step. Allow inspection, restoration and branching from a retained step. Intermediate snapshots would not become accepted code automatically. Their retention period still needs measurement; accepted records would keep their existing protections.
- **Can another worker start with a usable environment?** Prepare an isolated workspace with dependencies already present. Explore filesystem cloning where supported, measure its time and disk use, and provide an explicit fallback.

These interactions are planned, not implemented features of this preview. Later work would depend on the first workflow comparison: a requested conflict resolver could use both changes and their goals to propose a resolution for independent review; inherited write scopes could prevent a child thread from widening its allowed paths without approval. Those scopes would govern acceptance, not replace operating-system isolation.

## Why evaluate a custom source store?

The narrower storage question is whether owning a small source model makes the required workflow simpler to implement and maintain. The prototype keeps source state and workflow records in SQLite, so the accepted revision and task-completion decision can share a transaction. I want to test whether extending that model makes step retention, attribution and recovery easier to coordinate without adding more complexity elsewhere.

A Git-backed design could retain immutable Git objects and record the accepted commit ID with review and completion records in SQLite, then reconcile Git refs and workspaces from that decision. It would need explicit object retention and recovery. That is a viable alternative for the same user-facing features.

The custom implementation gives me a way to explore operations around agent steps and review decisions directly. It also means maintaining a revision format, reconstruction logic, retention, recovery and Git interoperability. Exact versions and branching alone do not justify that cost. I would keep the custom layer if it simplifies workflow coordination enough to outweigh that additional maintenance.

## What the experiments have shown

Isolated local storage experiments found avoidable overhead in the original implementation: replaying history repeatedly checked unchanged parts of the project, and changed file versions retained their full bytes. Experimental candidates used incremental path accounting, bounded compression and deltas, and database optimizations to reduce those costs while preserving the tested integrity, permission, capacity and transaction checks.

The tradeoffs remain material. Git packed the tested histories more tightly. Compression increased memory use and import cost in some cases, and full historical validation still grows with the amount of history checked. The optimized candidates remain separate from the application and are not included in this repository's original source example.

Those experiments establish implementation headroom, not a backend winner. The Git comparison used command-line processes and different ordinary integrity-check behavior. It did not compare an efficient persistent Git integration under equivalent safety checks.

## What would justify keeping it

I plan to evaluate the two decisions separately:

1. **Backend cost.** Compare against a persistent Git backend without repeated CLI startup, with equivalent integrity, permission, acceptance and recovery checks. Measure latency, memory, retained disk space and maintenance as the project and history grow.
2. **Workflow value.** Compare the native approach with Git worktrees on the same real tasks and provider limits. Measure workspace readiness, manual interventions, recovery effort and the time needed to explain why selected lines exist, alongside wall time and provider usage.

Both comparisons remain future work. The workflow needs to reduce the effort of supervising and recovering agent work. The backend needs to meet correctness and compatibility requirements at an acceptable cost in resources and maintenance. If Git supports the same experience with less engineering overhead, I would change the storage choice.

[Return to the Lillia overview](../README.md)
