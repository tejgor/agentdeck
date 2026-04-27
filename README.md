# deckhand

Fresh Ink-based rewrite prototype for multi-agent terminal workflow.

## What it does today

- runs as a standalone app under `ink/`
- uses a background daemon to keep sessions alive
- creates `claude` or `pi` sessions backed by daemon-owned PTYs
- shows a persistent split view with an instance sidebar and Preview / Terminal / Git / Dev tabs
- lets you cycle sessions with `j` / `k` and watch the preview follow selection
- attaches/detaches from running sessions
- freezes the last preview frame when a session exits
- stores state in `~/.deckhand/ink-state.json`
- writes daemon diagnostics to `~/.deckhand/ink-daemon.log`
- tracks the active daemon PID in `~/.deckhand/ink-daemon.pid`

## Run

```bash
cd ink
npm install
npm run dev
```

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
- press `enter` to create

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
- `Ctrl+Space` detaches and returns to Ink

## Notes

- Deckhand is inspired by `claude-squad` and implemented as an independent TypeScript/Ink application.
- The daemon uses `node-pty` directly for long-lived PTY sessions.
- Live Preview is powered by a daemon-side `@xterm/headless` terminal model so cursor rewrites and in-place updates render as terminal screen state instead of raw scrollback.
- On macOS, `npm install` runs `scripts/fix-node-pty.js` to repair the `spawn-helper` executable bit and apply best-effort quarantine removal / ad-hoc codesigning.
