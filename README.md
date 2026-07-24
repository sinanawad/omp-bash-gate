# omp-bash-gate

Model-assisted bash command safety gate for [Oh My Pi](https://github.com/can1357/oh-my-pi).

Replaces omp's per-command bash approval prompts with a three-tier classifier: trivially-safe commands run instantly, dangerous commands are blocked instantly, and ambiguous commands are classified by a cheap LLM call that decides whether to allow, prompt, or block.

## How it works

| Tier | Behavior | LLM call? |
|---|---|---|
| **Allowlist** | Instant allow — `ls`, `cat`, `grep`, `git status`, `pwd`, `head`, `tail`, `wc`, `find`, `echo`, `date`, `whoami`, etc. | No |
| **Blocklist** | Instant block — `rm -rf /`, fork bombs, `dd of=/dev/`, `mkfs`, `> /etc/passwd`, `chmod 777`, `shutdown` | No |
| **Model** | LLM classifies as `safe` / `risky` / `dangerous`. `safe` → allow, `dangerous` → block, `risky` → prompt user (or block in subagents) | Yes |

Fail-safe: if the model call fails or times out, it retries once, then blocks.

## Install

### Option A — Plugin install (recommended)

```bash
omp plugin install github:sinanawad/omp-bash-gate
```

Restart omp after installation.

### Option B — Clone + extensions setting

```bash
git clone https://github.com/sinanawad/omp-bash-gate.git ~/repos/omp-bash-gate
```

Add to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/repos/omp-bash-gate
```

### Option C — Copy single file

```bash
cp src/bash-gate.ts ~/.omp/agent/extensions/bash-gate.ts
```

## Configuration

The extension reads the OpenRouter API key from omp's auth store at runtime — no manual key configuration needed if you've already run `omp auth login openrouter`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `BASH_GATE_MODEL` | `anthropic/claude-haiku-4.5` | Model id for classification (OpenRouter format, no `openrouter/` prefix) |
| `BASH_GATE_TIMEOUT_MS` | `5000` | API call timeout in milliseconds |
| `BASH_GATE_MAX_TOKENS` | `16` | Max output tokens for the classifier |
| `BASH_GATE_DEBUG` | (unset) | Set to `1` for verbose logging |

**Model selection:** Use a non-thinking model for reliable single-word output. Thinking models (gemini-3.5-flash, deepseek-v4-pro, kimi-k2.5+) may consume their token budget on reasoning and return empty output. Tested working models:

- `anthropic/claude-haiku-4.5` (recommended — non-thinking, cheap, reliable)
- `anthropic/claude-3.5-haiku` (non-thinking, cheaper)

### Recommended omp settings

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: yolo
  approval:
    bash: allow
```

This lets the gate be the sole safety layer for bash commands. The native `bash: prompt` would otherwise prompt on every non-allowlisted command, which defeats the purpose.

## Test

```bash
cd omp-bash-gate
bun test
```

Tests use `bun test` with mocked fetch — no API key or network needed.

## Security notes

This extension is a policy and confirmation layer, not an OS-level sandbox. Shell parsing is complex and pattern-based classification cannot prove an unmatched command is safe. Run omp in an isolated environment when executing untrusted code.

The allowlist is intentionally conservative. If you need to add commands, edit `ALLOW_PATTERNS` in `src/bash-gate.ts`. Do not add `rm`, `mv`, `curl`, or other state-changing commands to the allowlist — those should go through the model classifier.

## License

MIT
