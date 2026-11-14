# Lillia: AI Coding Agent Orchestrator

Lillia is a local prototype for coordinating AI coding tasks through implementation, independent review, and validation. It keeps the goal, source revisions, agent activity, and review decisions together in one workspace.

The application connects to **Claude and Codex** through provider adapters. A Node.js background service and SQLite database support a command-line interface and an Electron desktop client. Both clients inspect the same retained workflow history.

![Lillia desktop workspace with project chat, goal navigation, a message composer, and contextual inspector tabs.](assets/workspace.png)

*The desktop workspace, with project chat, recorded goals, and contextual review panes.*

## How it works

1. **Define the task.** Record an objective, allowed source scope, and required checks.
2. **Implement a change.** An author agent works within that scope and submits a candidate revision.
3. **Review and validate.** A separate reviewer inspects the candidate and runs the required checks. Review decisions and validation evidence are associated with the specific revision.
4. **Accept the revision.** The service checks that the candidate, review, and validation records match before advancing the protected local mainline.

## Why Lillia stores source revisions

An agent can produce several versions of a change while working on a task. Reviewing revision A does not establish whether revision B is correct. Lillia retains the exact source for each revision and records which revision a check or review covers. Before accepting a change, the service verifies that the evidence matches the selected candidate.

The source store gives the agent workflow a bounded source history in SQLite, alongside its task and review records. Acceptance uses an expected target revision and update counter, so an older request cannot overwrite a target that has moved. Changing the accepted version and recording that change happen together; if recording fails, the accepted version stays where it was.

SQLite retains goals, attempts, and decisions across service restarts, including interrupted work. The desktop exposes the brief, progress, agent activity, and technical records behind each task.

The broader goal is to make an agent's work traceable: **why is this line here, which agent turn produced it, and what was checked before it was accepted?** Planned additions would connect accepted lines to their originating conversations and let users inspect, restore or branch from retained intermediate steps. Those interactions are not implemented yet; the current source and workflow records provide a foundation for them.

## Completed example

A bounded pilot added a **Show all matches** button to the sample profile in a League of Legends analytics application. When a queue filter produced an empty history, the button cleared that filter and restored eight match links and the recent performance summary without requesting backend or Riot data.

The author changed one component and its test file. A separate reviewer inspected the submitted revision and reran the regression before approving it. Both roles used separate Claude sessions in this pilot; other controlled workflows exercised Claude and Codex together.

The saved validation record for the reviewed change includes lint, type checking, 511 unit tests, three sample browser cases, and a webpack production build. Desktop and phone-width interaction checks verified the restored links and keyboard navigation.

![Lillia desktop showing a completed League task, separate author and reviewer roles, workflow stages, and recorded approval.](assets/completed-task.png)

*The completed League task in the same desktop interface. Its activity history retains an interrupted reviewer attempt and the subsequent approval.*

## Current status

Lillia is a working local prototype. The demonstrated League workflow used an existing application and a defined two-file scope. Broader whole-application delivery, longer normal-use evaluation, physical sleep/reboot recovery, and continued execution on another host remain unfinished.

The custom source layer is also an architectural experiment. [Source control for agent workflows](docs/source-control.md) explains the broader direction, why we are exploring our own store, what local experiments have shown, and how we plan to compare it with Git. The persistent-backend and real-task workflow comparisons remain future work.

## Selected source

The [source storage and review example](examples/source-and-review/README.md) shows the implemented foundation for that work: retaining the code an agent changed, rejecting outdated updates, and recording acceptance consistently. It includes the original implementation, a runnable SQLite demonstration, failure tests, and a walkthrough of how the service matches review evidence to the candidate. The example runs without model accounts or external packages.

This repository contains the overview, screenshots and selected source example. The complete application source remains private.
