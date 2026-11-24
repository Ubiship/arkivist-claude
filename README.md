# Arkivist for Claude Code

Message your own Claude Code from Arkivist chat, from your phone or any device. Your Claude Code runs on your computer; this plugin is the bridge. Supported on macOS and Linux.

## Before you start: Claude Team and Enterprise plans

If your Claude account belongs to a Team or Enterprise organisation, an admin of that organisation must allow channels first: set `channelsEnabled: true` in the organisation's managed settings for Claude Code. Without it, Claude Code starts but says *"blocked by org policy … Inbound messages will be silently dropped"*, and nothing you send from Arkivist arrives. Personal plans need nothing.

## Install

1. In the Arkivist portal, open Settings and create a pairing code for Claude Code.
2. On the computer where Claude Code runs (Node.js 20 or newer):

   ```
   npx @arkivist/claude connect <code> --server https://<your-arkivist-address>
   ```

   This redeems the code, saves the connection to `~/.config/arkivist/agent.json` (readable only by you), installs the `arkivist` plugin into Claude Code (`claude plugin marketplace add Ubiship/arkivist-claude`, then `claude plugin install arkivist@arkivist`), and writes a launcher at `~/.local/bin/arkivist-claude-start`. If `~/.local/bin` is not on your PATH, the command tells you.

   For testing from a local clone, add `--marketplace /path/to/clone`. Inside Claude Code you can also run `/arkivist:pair <code> --server <url>`.

## Launch

```
arkivist-claude-start
```

This runs `claude --dangerously-load-development-channels plugin:arkivist@arkivist` and passes any other arguments through. `arkivist-claude launch` does the same.

Your Claude Code can only be reached while it is running. To keep it connected after you close the terminal:

```
arkivist-claude-start --background
```

This starts it in a background `tmux` session in the current folder (on a Mac, `brew install tmux` first) and, on a Mac, keeps the computer from sleeping while it runs. The first time, attach once to confirm the screen below: `tmux attach -t arkivist-claude`, then press Ctrl-b, then d, to leave it running. If your computer sleeps or the network drops, it reconnects by itself.

Only the Claude Code that `arkivist-claude-start` (or `arkivist-claude launch`) starts connects to Arkivist: the launcher sets `ARKIVIST_CHANNEL=1`, and every other Claude Code session on the computer leaves the connection alone. If you start Claude Code some other way as a channel, set `ARKIVIST_CHANNEL=1` yourself.

Paired with an older version? Run `npx @arkivist/claude@latest launcher` to get the new launcher; no new code is needed.

### The confirmation screen

Claude Code's channels are a research preview, and only an approved list of channels may load normally. Until this plugin is on that list, Claude Code shows a full-screen warning when you start it this way. Choose **I am using this for local development** to continue. The flag lets this one plugin load; it does not widen anything else. Run in an interactive session: Claude Code ignores the flag with `-p`. Team and Enterprise organisations also need channels allowed (see *Before you start*).

## What data goes where

- A message you send from Arkivist chat travels through the Arkivist server to your Claude Code, and Claude's replies travel back the same way.
- **The agent chat is not end-to-end encrypted.** The Arkivist server can read it in transit, unlike your other encrypted chats.
- Claude Code acts on your computer with your permissions. Tool approval prompts can be answered from Arkivist chat as well as the terminal.
- The saved connection holds a secret token. Anyone who can read that file can act as your Claude Code's link to Arkivist. Disconnect it in the portal if a computer is lost.
- Only one Claude Code session holds the connection at a time; a newer one replaces the older.

## Development

```
npm run build   # tsc -> dist/ (CLI), esbuild -> plugin/dist/server.js (bundled channel server)
npx vitest run && npx tsc --noEmit
npm run check:bundle   # fails if plugin/dist/server.js is stale
```

Publishing: `scripts/publish-repo.sh` (or `--dry-run`) builds, tests and pushes this folder, with `dist/` built, to the public `Ubiship/arkivist-claude` repo members install from. The source of truth is this folder in the UbiComm repo.

`plugin/dist/server.js` is committed on purpose: a marketplace install copies the plugin folder as-is, with no `node_modules` and no build step. Rebuild and commit it with any change under `src/` (a test and `npm run check:bundle` fail when it is stale).

## Licence

Copyright © 2026 Arkivist Systems Corp. All rights reserved. Published so members can read and install it; see `LICENSE`.
