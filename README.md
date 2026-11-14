# Lillia: AI Coding Agent Orchestrator

Lillia is my local prototype for coordinating AI coding tasks through implementation, independent review, and validation. It keeps the goal, source revisions, agent activity, and review decisions together in one workspace.

The application connects to **Claude and Codex** through provider adapters. A Node.js background service and SQLite database support a command-line interface and an Electron desktop client. Both clients inspect the same retained workflow history.

![Lillia desktop workspace with project chat, goal navigation, a message composer, and contextual inspector tabs.](assets/workspace.png)

*The desktop workspace, with project chat, recorded goals, and contextual review panes.*

## How it works

1. **Define the task.** Record an objective, allowed source scope, and required checks.
2. **Implement a change.** An author agent works within that scope and submits a candidate revision.
3. **Review and validate.** A separate reviewer inspects the candidate and runs the required checks. Review decisions and validation evidence are associated with the specific revision.
4. **Accept the revision.** The service checks that the candidate, review, and validation records match before advancing the protected local mainline.

## Why connect source and agent history?

When an agent's work changes or gets interrupted, I want to understand what it tried, which version was reviewed, and which checks support the accepted result. Lillia keeps goals, attempts, candidate revisions and review decisions together so that context can be inspected without piecing it together from separate conversations and terminal output.

The current flow retains exact candidate versions and records which version a review or check covers. Approval of revision A does not approve a later revision B. Before acceptance, the service checks the evidence against the selected candidate and rejects an update if the accepted target has moved. Updating the source reference and recording that change happen together; if recording fails, the reference stays where it was.

The experience I want to build would let someone select an accepted line, open the agent turn and review behind it, or inspect and restore an earlier attempt without confusing that attempt with accepted code. Those interactions are planned; the current source and workflow records provide their foundation.

Git can preserve the source versions for this kind of tool. Lillia's focus is connecting those versions to the work that produced them. The custom SQLite source layer is one implementation approach I am evaluating for that workflow.

## Completed example

A bounded pilot added a **Show all matches** button to the sample profile in a League of Legends analytics application. When a queue filter produced an empty history, the button cleared that filter and restored eight match links and the recent performance summary without requesting backend or Riot data.

The author changed one component and its test file. A separate reviewer inspected the submitted revision and reran the regression before approving it. Both roles used separate Claude sessions in this pilot; other controlled workflows exercised Claude and Codex together.

The saved validation record for the reviewed change includes lint, type checking, 511 unit tests, three sample browser cases, and a webpack production build. Desktop and phone-width interaction checks verified the restored links and keyboard navigation.

![Lillia desktop showing a completed League task, separate author and reviewer roles, workflow stages, and recorded approval.](assets/completed-task.png)

*The completed League task in the same desktop interface. Its activity history retains an interrupted reviewer attempt and the subsequent approval.*

## Current status

Lillia is a working local prototype. The demonstrated League workflow used an existing application and a defined two-file scope. Broader whole-application delivery, longer normal-use evaluation, physical sleep/reboot recovery, and continued execution on another host remain unfinished.

The custom source layer is also an architectural experiment. [Source control for agent workflows](docs/source-control.md) explains the broader direction, why I am evaluating a custom store, what local experiments have shown, and how I plan to compare it with Git. The persistent-backend and real-task workflow comparisons remain future work.

## Selected source

The [source storage and review example](examples/source-and-review/README.md) shows the implemented foundation for that work: retaining the code an agent changed, rejecting outdated updates, and recording acceptance consistently. It includes the original implementation, a runnable SQLite demonstration, failure tests, and a walkthrough of how the service matches review evidence to the candidate. The example runs without model accounts or external packages.

This repository contains the overview, screenshots and selected source example. The complete application source remains private.
