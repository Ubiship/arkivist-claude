---
description: Connect this Claude Code to your Arkivist account with a pairing code
argument-hint: <code> [--server URL]
allowed-tools: Bash(npx @arkivist/claude connect:*)
---

Connect this machine to the user's Arkivist account. Arguments given: $ARGUMENTS

The terminal command is the preferred way to pair (`npx @arkivist/claude connect <code> --server <url>`); mention that to the user.

Before running anything, check the arguments:

1. The code must match `^[2-9A-HJKMNP-TV-Z]{3}-?[2-9A-HJKMNP-TV-Z]{3}$` (case-insensitive: letters and digits, never 0, 1, I, L, O or U), like `K7M-4QX`. If it does not, stop and ask the user to re-copy it from the Arkivist portal.
2. The `--server` value, if given, must be an `https://` address (or `http://localhost...`). If none was given, ask for their Arkivist address first.
3. Reject anything else in the arguments (no extra words, no shell characters such as `;`, `&`, `|`, `$`, backticks, quotes or newlines).

Then run exactly this, with each argument double-quoted:

```
npx @arkivist/claude connect "<code>" --server "<server>"
```

Show its output. If it succeeds, tell the user to restart Claude Code with `arkivist-claude-start` so the connection loads. Never print or repeat the pairing token.
