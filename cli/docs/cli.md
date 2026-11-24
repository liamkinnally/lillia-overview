# Install the CLI and try a reviewed change

## Tested setup

Use an Apple Silicon Mac with Darwin `25.3.0`, the tested Node.js `v24.22.2` binary, Git, and Codex CLI `0.171.0-alpha.13` with a paid ChatGPT account that can use `gpt-6.2-astra`. Check the host with `uname -m`, `uname -r`, and `node -v`. The workflow verifies its runtime and sandbox profile during setup. This alpha has been exercised on one Mac. To check the executable itself, run the following command. The expected SHA-256 is `b6fb419f0f43bb2fbca273700294dd2f3b685a64b60e8417c295f47646a70e4a`.

```sh
node -p "process.execPath" | xargs -I {} shasum -a 256 "{}"
```

Lillia prefers the Codex runtime bundled in ChatGPT for macOS. A different `codex` on your shell path can report another version. The guided session uses Codex for conversation, implementation and independent review. Running the demo and asking the main agent questions use your own provider allowance.

## Install

```sh
npm install --global --prefix "$HOME/.local" --ignore-scripts https://github.com/liamkinnally/lillia-overview/releases/download/v0.1.0-alpha.1/lillia-0.1.0-alpha.1.tgz
```

The installed command is `~/.local/bin/lillia`. You can type `lillia` directly if `~/.local/bin` is on your shell path. To compare the downloads with the release, run `shasum -a 256` on each downloaded file and compare it with `SHA256SUMS` in the release assets.

## First task

From a folder where you keep projects, download the small standalone Git example. It has one function, one passing test, a package manifest and a lockfile. It needs no third-party npm dependencies.

```sh
curl -fL -o range-label.bundle https://github.com/liamkinnally/lillia-overview/releases/download/v0.1.0-alpha.1/range-label.bundle
git clone range-label.bundle lillia-range-example
cd lillia-range-example
npm test
~/.local/bin/lillia
```

1. If Lillia offers to connect Codex, answer `yes` and complete the native sign-in. The terminal shows `Signed in with ChatGPT` when it recognizes the account.
2. Confirm the example folder. Review the commit and the detected `npm run test` check. Press Enter for the suggested patch directory. For this example, use two total attempts (one author and one reviewer) and 600 active seconds. Confirm registration.
3. Ask **“When both ends of a range are equal, show the number once. Keep the existing formatting for unequal bounds and add a regression test.”** Review the proposed objective and confirm to start.
4. Watch the recorded file operations and check results. On approval, inspect the diff and choose whether to save the patch. Lillia checks whether it applies and prints the exact `git apply` command. Apply it in the example folder, then run `npm test` to check the result yourself.
5. Type `/quit` and reopen `~/.local/bin/lillia`. Confirm the same folder. `/status` shows the latest task, `/diff` previews its accepted change, and `/watch` replays its activity without starting another task.

## Using your own repository

Start with a small, clean SHA-1 Git checkout with a standard `.git` directory, a supported npm check and a version 3 package lock. Dependency archives for projects that need external packages must already be cached locally. Setup shows the editable package directories and the checks it detected. The main agent can request a listed text file from the registered commit. Its initial inventory includes up to 48 files of up to 16 KiB each. Workers use Lillia’s retained revisions. Uncommitted working-tree edits and later Git changes do not automatically enter that history.

Use `/open PATH` to select another project. Use `/settings` to change the patch destination or the limits for future runs. Allowed limits are 2–8 total attempts and 1–1,800 active seconds. `/help` lists session commands. Completed tasks, settings, and recent conversation stay on this computer. Reopening an active task lets you follow it with `/watch`.

## Reverify a provider version

This alpha supports the exact native and host versions above. A signed-out older Codex can offer sign-in before Lillia detects the version mismatch. If sign-in succeeds but startup or project setup stops, compare the actual host and Codex versions with the tested setup. This command reports the bundled version.

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version
```

Progress, review and patch export can be inspected locally once a task has run. The alpha includes no Electron installer and has no interactive Claude sign-in option.

## Where the name Scion appears

Scion was the project's earlier name, and it remains part of the stored formats. The default data directory is `~/.local/share/scion`, retained Git revisions use refs under `refs/scion/`, temporary folders start with `scion-`, and native file identities include `scion-native` in their hash input. Changing those names would change stored identities, so they stay as they are. `SCION_DATA_DIR` and `SCION_WORKSPACE_ROOT` are still accepted as fallbacks for `LILLIA_DATA_DIR` and `LILLIA_WORKSPACE_ROOT`. The installed command is only `lillia`.
