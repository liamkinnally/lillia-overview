# Source control for agent workflows

Lillia's source-control work aims to make an agent's changes easy to inspect, explain and recover. The useful history includes the code, the goal that prompted it, the agent turn that changed it, and the review and checks that supported accepting it.

That matters when several agents work on one project. A thread may try several approaches, a reviewer may reject an early candidate, and another task may move the accepted version forward. The workspace should make those relationships visible without requiring someone to piece them together from conversations, terminal output and source history.

## What exists today

The prototype has a custom versioned-source layer built on SQLite. SQLite supplies the database machinery; Lillia defines the file identities, revisions and acceptance rules above it.

- **Exact retained versions.** File contents and revisions have content-derived identities. Earlier versions remain available when an agent produces a new candidate.
- **Review tied to a candidate.** The surrounding service associates review and validation evidence with the revision being considered. Approval of revision A does not automatically approve a later revision B.
- **Conditional acceptance.** An expected target revision and update counter prevent an outdated request from replacing a target that has moved.
- **Consistent acceptance records.** The source reference and its history event update together. The demonstrated project flow also records source acceptance and task completion in one SQLite transaction.

The [runnable source example](../examples/source-and-review/README.md) exposes the original store, its limits and failure tests. The [review walkthrough](../examples/source-and-review/docs/review-sequence.md) explains the service-side checks around it. The storage layer alone does not decide whether an agent's work is correct or authorized.

## The interactions we want to build

The next work would use those records to answer questions people have while supervising agents:

- **Why is this line here?** Follow an accepted line to the revision, goal, originating agent turn and review decisions behind it. Imported code and missing attribution should be identified explicitly. Unaccepted work would show its owning thread and retained step.
- **What happened between the start and the final submission?** Retain a private snapshot after each file-changing tool call, with a diff for that step. Allow inspection, restoration and branching from a retained step. Intermediate snapshots would not become accepted code automatically. Their retention period still needs measurement; accepted records would keep their existing protections.
- **Can another worker start with a usable environment?** Prepare an isolated workspace with dependencies already present. Explore filesystem cloning where supported, measure its time and disk use, and provide an explicit fallback.

These interactions are planned, not implemented features of this preview. Later work would depend on the first workflow comparison: a requested conflict resolver could use both changes and their goals to propose a resolution for independent review; inherited write scopes could prevent a child thread from widening its allowed paths without approval. Those scopes would govern acceptance, not replace operating-system isolation.

## Why investigate a custom source store?

The hypothesis is that keeping source state and agent-workflow records in one small, queryable model can make these interactions easier to implement and use. The prototype already puts the accepted revision and the corresponding workflow decision under one transactional authority. Extending that model could let a user move directly from a change to the work that produced it, or restore an intermediate step without reconstructing its context manually.

Git can also retain exact versions, and these user-facing features could be built around Git. A Git-backed design could retain immutable Git objects and record the accepted commit ID with review and completion records in SQLite, then reconcile Git refs and workspaces from that decision. It would need explicit object retention and recovery, but would not require a custom revision format.

The reason to continue exploring Lillia's store is therefore the potential to simplify the whole agent workflow. Owning the format also creates work: revision reconstruction, retention, recovery, compatibility and Git interoperability all need maintenance. The custom layer has to earn that cost through a better experience or a simpler implementation of the required guarantees.

## What the experiments have shown

Isolated local storage experiments found avoidable overhead in the original implementation: replaying history repeatedly checked unchanged parts of the project, and changed file versions retained their full bytes. Experimental candidates used incremental path accounting, bounded compression and deltas, and database optimizations to reduce those costs while preserving the tested integrity, permission, capacity and transaction checks.

The tradeoffs remain material. Git packed the tested histories more tightly. Compression increased memory use and import cost in some cases, and full historical validation still grows with the amount of history checked. The optimized candidates remain separate from the application and are not included in this repository's original source example.

Those experiments establish implementation headroom, not a backend winner. The Git comparison used command-line processes and different ordinary integrity-check behavior. It did not compare an efficient persistent Git integration under equivalent safety checks.

## What would justify keeping it

Two comparisons still matter:

1. **Backend cost.** Compare against a persistent Git backend without repeated CLI startup, with equivalent integrity, permission, acceptance and recovery checks. Measure latency, memory, retained disk space and maintenance as the project and history grow.
2. **Workflow value.** Compare the native approach with Git worktrees on the same real tasks and provider limits. Measure workspace readiness, manual interventions, recovery effort and the time needed to explain why selected lines exist, alongside wall time and provider usage.

Both remain future work. The custom store is worth keeping if it makes that work meaningfully easier while meeting correctness, compatibility and resource requirements. If a Git-backed implementation supports the same experience with less maintenance, it would be a strong reason to change the storage choice. The goal remains an inspectable, recoverable agent workflow.

[Return to the Lillia overview](../README.md)
