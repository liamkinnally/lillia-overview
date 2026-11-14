# Review bound to exact source

An approval is useful only if it covers the source being accepted. If a reviewer approves revision A and later edits produce revision B, the service must distinguish those versions before accepting either one. It must also detect whether the accepted target has moved since the task began.

The source store supplies retained bytes and stable revision identities. The workflow records which revision each agent read or changed and which revision its checks and verdict cover. The service validates those records before asking the store to advance the accepted reference, a named pointer to the current accepted revision. That division gives the review logic an exact source history to check and the storage layer a specific update to apply.

This walkthrough contains selected internal source excerpts from snapshot `a09c83bd79b844fbab28f90e2bff9ca50de7e7a3`. Paths and line numbers refer to that snapshot; the full application is not included. The [storage example](../README.md) is runnable. This document does not provide a standalone review verifier or run agents.

## Inputs and an illustrative sequence

`verifyProjectSequence(f, facts, base, final)` receives four prepared inputs:

| Input | Meaning |
| --- | --- |
| `f` | Workflow state: candidate revision, author submission and reviewer verdict, including check and execution evidence identifiers. |
| `facts` | Ordered, prevalidated tool observations derived from the retained journal. Check facts include role, attempt, revision, file identities, outcome and test titles. |
| `base` | `{ component, test }` file identities read from the admitted starting revision. |
| `final` | The same two file identities read from the selected candidate. These are identities of file bytes, not paths or source strings. |

The internal profile supplies `componentPath`, `testPath` and `paths`. The helper is therefore specific to an enrolled two-file change.

The following trace is **synthetic and illustrative**, not recorded agent execution, an executable fixture or a validation result. Labels such as `C0` abbreviate file identities; `R2` abbreviates a revision identity. Assume one regression test titled “preserves selection”.

| Order | Role / attempt | Operation | Revision | Component / test | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | author / A | Replace test | R0 → R1 | C0 / T1 | New regression retained |
| 2 | author / A | Run check `check-red` | R1 | C0 / T1 | Assertion fails |
| 3 | author / A | Replace component | R1 → R2 | C1 / T1 | Implementation changed |
| 4 | author / A | Run check `check-author` | R2 | C1 / T1 | Test passes |
| 5 | reviewer / B | Read both files | R2 | C1 / T1 | Exact candidate read |
| 6 | reviewer / B | Run check `check-review` | R2 | C1 / T1 | Same test passes |

Here `base = { component: C0, test: T0 }` and `final = { component: C1, test: T1 }`. The author submits R2 with `check-author`; the reviewer approves R2 with `check-review`. Their evidence names distinct executions.

## What the sequence checks

“Red” means an assertion failed with the new test and original implementation. “Green” means the checks passed with the final test and implementation. This distinguishes a reproduced regression from a failed command that never exercised the intended assertion.

The helper first requires both files to change and both verdicts to name the candidate. Its author-green lookup includes these exact predicates (`src/project-review-proof.mjs:41–47`):

```js
      o.role === 'author' &&
      o.tool === 'run_check' &&
      o.id === a.checkId &&
      o.revision === f.candidate &&
      o.component === final.component &&
      o.test === final.test &&
      o.outcome === 'passed'
```

An earlier red must use the original component and final test, with every failed title appearing among the green's passed titles. The journal must contain no component replacement before that red and no test replacement between red and green. A replacement followed by a reversion still violates the latter rule. The reviewer must read both enrolled paths on the candidate and pass its own named check with the final file identities and the same passed-title set (`src/project-review-proof.mjs:49–82`).

## Guarantees supplied by the caller

The helper does not validate arbitrary untrusted records. `roleState` checks verdict shape and retained execution evidence; `toolJournal` reconstructs source changes in journal order, verifies operation bindings and derives facts from validated checks (`src/project-review-proof.mjs:225–405`). Completed checks require nonempty, consistent test results (`src/project-validation.mjs:177–195`).

Before calling the helper, `boundFlow` requires each verdict's check to match its role, attempt and revision (`src/project-review-proof.mjs:498–503`):

```js
          o.role === role &&
          o.tool === 'run_check' &&
          o.attemptId === verdict.evidence.attemptId &&
          o.revision === verdict.revisionId &&
          o.id === verdict.checkId &&
          (verdict.decision === 'reject' || o.outcome === 'passed')
```

It also rejects author operations after review begins and requires distinct author/reviewer task, attempt, session, run, message and result identifiers. The account instance is shared; independence here means separate recorded executions. Journal entries must belong to those executions, with a separately checked recovery exception (`src/project-review-proof.mjs:489–534`).

These preconditions matter when reading the short helper: an empty failed-title array makes its `every` predicate true; it does not itself bind the author's attempt, establish distinct executions or enforce the complete role ordering. Missing evidence can cause a raw property-access error. Those are limits of using the helper in isolation, not evidence of a bypass through the complete application path.

## From proof to reference advancement

The platform wires `proveLanding` to `projectLandingProof`, which runs the terminal bound flow (`src/platform.mjs:299`; `src/project-review-proof.mjs:552–555`). Completion then uses the resulting proof before advancing the reference (`src/project-development.mjs:605–613`):

```js
    const landing = this.proveLanding(this.db, f.goalId, this.checkEvidence);
    this.source.advanceRef({
      repository: landing.repository,
      name: 'mainline',
      expectedRevision: landing.expectedTarget,
      expectedGeneration: landing.expectedGeneration,
      revisionId: landing.candidate,
      operationId: landing.operationId
    });
```

The expected revision and generation prevent this proof from advancing a target that has since changed. In this project workflow, completion runs inside the same SQLite transaction as the source update and landing record (`src/project-development.mjs:604–638, 681–699`). This integration lets the service record the accepted code and the completed task together. The store's savepoint additionally keeps the reference and its history consistent if a caller catches an error during the update.

The storage sample demonstrates the conditional update and its history behavior. The application supplies the provider evidence validation, reviewer recovery and task-completion logic described here.

These records connect an accepted revision to the work and checks behind it. The planned line-to-conversation view and intermediate-step restore would extend that connection; they are not demonstrated by this sample. See [the design direction and Git tradeoff](../README.md#from-source-history-to-agent-history) for the broader scope.
