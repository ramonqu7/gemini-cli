# Experimental Builds

Pre-built launcher scripts for the enhanced Gemini CLI fork.

## Quick Start (Google Internal)

```bash
# Option 1: Direct launcher (uses your local build + official proxy)
./run-internal.sh

# Option 2: Self-contained binary
./gemini-internal
```

Both automatically:
- Start the internal API proxy (`gemini_api_proxy`)
- Authenticate via Gaia MINT (corp SSO)
- Fetch experiment flags
- Enable telemetry to Sawmill
- Run in YOLO mode (all tools auto-approved, except external writes)

## Features (45+)

See the full feature list in the [design doc](../../docs/plans/2026-03-05-deep-dive-design.md).

### Key Commands
| Command | Description |
|---------|-------------|
| `/fast` | Toggle flash/pro model |
| `/cost` | Show token usage + cost |
| `/plan auto` | Autonomous plan execution with test verification |
| `/bg <prompt>` | Run task in background |
| `/rewind N` | Go back N conversation turns |
| `/export` | Save conversation as markdown |
| `/history` | Search past prompts |
| `/stats` | Developer intelligence dashboard |
| `/init` | Auto-detect project + generate GEMINI.md |

### Safety
- External writes (buganizer, CLs, docs) always require confirmation
- Git force-push/reset-hard blocked even in YOLO mode
- Read-before-write warnings on blind file overwrites

## Building from Source

```bash
cd ~/gemini-cli
npm install
npm run build
./build-sar.sh  # Creates dist/gemini-internal
```

## Configuration

Settings: `~/.gemini/settings.json`

```json
{
  "general": {
    "defaultApprovalMode": "yolo"
  },
  "knowledge": {
    "teamSources": ["/path/to/shared/oncall-knowledge/"]
  },
  "tools": {
    "permissions": [
      {
        "tool": "run_shell_command",
        "allow": ["^npm test", "^git status"],
        "deny": ["^rm -rf", "^sudo"]
      }
    ]
  }
}
```
