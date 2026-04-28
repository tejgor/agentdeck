# Deckhand

A standalone terminal workbench for managing local coding-agent sessions.

Deckhand is inspired by the [claude-squad](https://github.com/smtg-ai/claude-squad) project.

## What it does today

- runs as a standalone terminal app
- uses a background daemon to keep sessions alive
- creates `claude` or `pi` sessions backed by daemon-owned PTYs
- shows a persistent split view with an instance sidebar and Preview / Terminal / Git / Dev tabs
- lets you cycle sessions with `j` / `k` and watch the preview follow selection
- attaches/detaches from running sessions
- freezes the last preview frame when a session exits
- stores state in `~/.deckhand/state.json`
- writes daemon diagnostics to `~/.deckhand/daemon.log`
- tracks the active daemon PID in `~/.deckhand/daemon.pid`

## Install as a CLI

From this checkout:

```bash
npm install
npm run build
npm link
```

Then launch it from any git repo:

```bash
deckhand
```

For a global install without a symlink, use:

```bash
npm install -g .
```

After changing source code, rebuild before using the linked CLI again:

```bash
npm run build
```

The CLI binary is declared in `package.json` as `deckhand -> dist/cli.js`, so the built `dist/cli.js` file is what gets put on your `PATH`.

## Controls

### Main view

- `n` new session
- `tab` cycle Preview / Terminal / Git / Dev tabs
- `o` attach to selected running session's active tab
- `d` start/stop the selected running session's dev command
- `j` / `k` move between sessions
- `x` kill selected running session
- `delete` remove selected exited session
- `r` refresh
- `q` quit

### Create flow

- choose `claude` or `pi`
- enter a name
- press `tab` to cycle workspace mode: no worktree, new worktree, existing worktree
- press `enter` to create

### Worktree hooks

For new-worktree sessions, Deckhand first creates or resolves a git worktree, then starts the selected agent inside it. If present, Deckhand uses this project hook before falling back to built-in `git worktree add`:

```txt
.claude/scripts/create-worktree.sh
```

Hook contract:

- read JSON from stdin
- use `name` as the sanitized worktree/session name
- use `cwd` as the exact directory where `deckhand` was launched; this may be the main repo or an existing linked worktree
- create/register a git worktree
- print the absolute worktree path to stdout as the final non-empty line
- exit `0` on success

Deckhand also sets `CLAUDE_PROJECT_DIR` to the launch cwd for compatibility with Claude-style hooks.

Input example:

```json
{"name":"my_feature","cwd":"/path/to/current/worktree"}
```

Minimal hook:

```bash
#!/bin/bash
set -e

INPUT="$(cat)"
NAME="$(echo "$INPUT" | jq -r '.name // "worktree"')"
CWD="$(echo "$INPUT" | jq -r '.cwd // env.CLAUDE_PROJECT_DIR // env.PWD')"
DIR="$HOME/.deckhand/worktrees/$NAME"
START="$(git -C "$CWD" rev-parse HEAD)"

if [ -d "$DIR/.git" ] || git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "$DIR"
  exit 0
fi

if [ -e "$DIR" ]; then
  echo "Path exists but is not a git worktree: $DIR" >&2
  exit 1
fi

if git -C "$CWD" show-ref --verify --quiet "refs/heads/$NAME"; then
  git -C "$CWD" worktree add "$DIR" "$NAME" >&2
else
  git -C "$CWD" worktree add -b "$NAME" "$DIR" "$START" >&2
fi

echo "$DIR"
```

If a hook copies symlinks from the source worktree, prefer resolving them with `realpath` so newly-created worktrees point directly at the real target instead of through another linked worktree. If no hook exists, Deckhand creates worktrees under `~/.deckhand/worktrees`.

### Dev command

The Dev tab is started explicitly with `d` for the selected running session. Configure the global command in `~/.deckhand/config.json`:

```json
{
  "dev_command": "npm run dev"
}
```

If `dev_command` is omitted, deckhand runs `dev`.

### Attach mode

- interact directly with the agent session
- `Ctrl+Space` detaches and returns to Deckhand

## Notes

- Deckhand is a standalone TypeScript/Ink implementation for managing local coding-agent sessions.
- Deckhand is inspired by `claude-squad` and implemented as an independent TypeScript/Ink application.
- The daemon uses `node-pty` directly for long-lived PTY sessions.
- Live Preview is powered by a daemon-side `@xterm/headless` terminal model so cursor rewrites and in-place updates render as terminal screen state instead of raw scrollback.
- On macOS, `npm install` runs `scripts/fix-node-pty.js` to repair the `spawn-helper` executable bit and apply best-effort quarantine removal / ad-hoc codesigning.
