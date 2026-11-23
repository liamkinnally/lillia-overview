# Lillia terminal alpha

Use Lillia to scope a coding task to a local repository, follow the author and reviewer in the terminal, and export the approved change. The guided alpha uses your native Codex sign-in. [Installation and first task](docs/cli.md)

## Source guide

| Path | Responsibility |
| --- | --- |
| [Terminal session](src/terminal-session.mjs) | Project selection, conversation, task confirmation, and following the work. |
| [Activity reader](src/session-activity.mjs) | Project-scoped file operations and check results shown by `/watch`. |
| [Local service](src/local-service.mjs) | Daemon startup and communication over local Unix sockets. |
| [Project workflow](src/project-development.mjs) | Author and reviewer tasks, validation evidence, and acceptance. |
| [Review evidence](src/project-review-proof.mjs) | Checks that the retained review and validation apply to the candidate. |
| [Guided result](src/guided-result.mjs) | Verification of an accepted revision and export of its Git patch. |
| [Provider adapters](src/adapters/) | Native Codex and Claude integration code used across the project. |
| [Earlier browser client](public/) | Static files for the earlier local web interface. The Electron app is a separate client. |

From this directory, run `npm test` for the published terminal, activity, and patch-export tests. These use local fixtures. The live demo uses your provider account and requires the versions in the install guide. The project has not been released under an open-source license.
