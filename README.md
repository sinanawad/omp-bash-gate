# omp-bash-gate

Model-assisted bash command safety gate for [Oh My Pi](https://github.com/can1357/oh-my-pi).

Three-tier command classifier for omp: trivially-safe commands run instantly, dangerous commands are blocked instantly, and ambiguous commands are classified by a cheap LLM call — routed through **your own configured omp provider** — that decides whether to allow, prompt, or block. When no model is configured, ambiguous commands prompt you directly; the plugin never silently picks a model or provider for you.

## How it works

| Tier | Behavior | LLM call? |
|---|---|---|
| **Blocklist** | Instant block — recursive force-delete of a dangerous target (`/`, `/*`, `~`, `$HOME`, `.`, system dirs), fork bombs, `dd of=/dev/…`, `mkfs …/dev/…`, `> /etc/{passwd,shadow,…}`, `chmod 777`, `> /dev/sd…`, shutdown/reboot, and piping a network download into a shell (`curl … \| sh`). | No |
| **Allowlist** | Instant allow — trivially safe **single** commands: `ls`, `cat`, `grep`, `pwd`, `echo`, `cd`, read-only `git`, non-destructive `find`/`fd`, etc. A command containing any shell operator (`;`, `&&`, `\|\|`, `\|`, `` ` ``, `$(`, `<`, `>`) is **not** allowlisted — it falls through to the classifier. | No |
| **Model** | The command is classified `safe` / `risky` / `dangerous`. `safe` → allow, `dangerous` → block, `risky` → prompt the user (or block in subagents with no UI). | Yes |

The blocklist runs **before** the allowlist, so a deterministic block can never be overridden by an allowlisted prefix. If the classifier fails or times out, it retries once, then prompts (with UI) or blocks (headless) — it never allows on an unknown.

**Any provider.** The classifier runs through omp's own model layer, so it uses whatever provider backs your chosen model — Anthropic, OpenAI, Google, OpenRouter, and [~60 others](https://github.com/can1357/oh-my-pi). Credentials come from omp's auth store; there is no separate key to configure.

## Install

### Option A — Plugin install (recommended for teams)

```bash
# installs whatever the default branch points at right now
omp plugin install github:sinanawad/omp-bash-gate

# or pin to a tag/commit so every machine provably runs the same code
omp plugin install github:sinanawad/omp-bash-gate#v0.2.0
```

Neither form auto-updates: the resolved commit is held in a lockfile, so an install stays put until you explicitly re-run the install command (see [Updating](#updating)).

Restart omp after installing. Verify with `omp plugin list` — you should see `omp-bash-gate` and its version.

This installs into omp's own plugins directory via `bun install`. The plugin declares **no runtime dependencies**: it imports `@oh-my-pi/pi-ai`, which omp resolves from its own installation through the extension loader's specifier shim (the `@oh-my-pi/*` packages are declared as *optional* peer dependencies precisely so they are not downloaded again).

### Option B — Clone + extensions setting

Best when you want to hack on it locally, since edits apply on the next omp restart.

```bash
git clone https://github.com/sinanawad/omp-bash-gate.git ~/repos/omp-bash-gate
```

Add to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/repos/omp-bash-gate
```

### Option C — Copy the single file

```bash
cp src/bash-gate.ts ~/.omp/agent/extensions/bash-gate.ts
```

`<omp config dir>/extensions/` is scanned automatically, so no config change is needed. This works because omp rewrites the plugin's `@oh-my-pi/*` imports to its own copies — but it means the copied file **cannot be imported by plain `bun`/`node` outside omp**, so don't try to smoke-test it standalone. It also carries no version identity (it reports `v unpackaged` at startup) and has **no update path**. Prefer A or B.

This is the least maintainable option — it carries no version identity and has **no update path** (see [Updating](#updating)). Prefer A or B.

## Configuration

Pick a classifier model with `/bash-gate`, or set `BASH_GATE_MODEL`. The model is an omp model spec resolved against your authenticated providers — any small model works. Reasoning is disabled automatically for the classifier call, so "thinking" models no longer waste their token budget on internal reasoning. Tested known-good picks:

- `anthropic/claude-haiku-4.5` (cheap, fast, reliable)
- `moonshotai/kimi-k2` (budget)

`/bash-gate` applies your choice **immediately** — no restart required.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `BASH_GATE_MODEL` | (none) | omp model spec for classification (e.g. `anthropic/claude-haiku-4.5`, a bare catalog id, or an `@role` alias). |
| `BASH_GATE_TIMEOUT_MS` | `5000` | Classifier timeout in ms. Invalid values fall back to the default with a warning. |
| `BASH_GATE_MAX_TOKENS` | `16` | Max output tokens for the classifier. |
| `BASH_GATE_STATE_FILE` | `<omp config dir>/agent/bash-gate.json` | Full path override for the saved-model state file. |
| `BASH_GATE_DEBUG` | (unset) | Set to `1` for verbose logging. |

**No model by default:** the plugin does not assume a provider or model. Until you run `/bash-gate` (or set `BASH_GATE_MODEL`), ambiguous commands prompt you (with UI) or block (headless). Safe and dangerous commands still work with no model.

### omp approval settings

By default the gate layers **on top of** omp's native approval. The safe, defense-in-depth setup is to keep omp's native bash prompt on (`write` mode, or `bash: prompt`): if the gate ever fails to load, you still get omp's prompt rather than silent execution.

If you want the gate to be the *sole* approval layer (fewer prompts), you can use `yolo` mode with `bash: allow`:

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: yolo
  approval:
    bash: allow
```

> ⚠️ **Read before enabling.** With `yolo` + `bash: allow`, omp auto-approves every bash command that the gate allows. If you later [uninstall or disable](#uninstall--disable) the plugin — or it fails to load after an update — bash becomes **fully auto-approved with no gate at all**. If you use this mode, revert `tools.approval.bash` whenever you remove the plugin.

## Updating

**Option A — re-run the install command.** For a git-installed plugin this *is* the upgrade path: omp detects the existing install, refreshes its git cache and runs `bun update`, so the new commit is actually picked up (rather than being a no-op against a stale lockfile pin).

```bash
omp plugin install github:sinanawad/omp-bash-gate      # tracking a branch
omp plugin install github:sinanawad/omp-bash-gate#v0.3.0   # moving to a new pin
```

Then restart omp and confirm the version in the startup banner or `omp plugin list`.

> Note: `omp plugin upgrade` operates on **marketplace** plugins. It will not update a plugin installed directly from a git URL — use the command above for that.

- **Option B:** `git -C ~/repos/omp-bash-gate pull`, then restart omp.
- **Option C:** no update path — re-copy the file manually.

## Rolling out to a team

1. **Tag a release** so everyone installs the same code:
   ```bash
   git tag -a v0.2.0 -m "bash-gate v0.2.0"
   git push origin v0.2.0
   ```
2. **Share one pinned install command** (so every machine provably runs the same code, and version moves are an explicit, reviewable step rather than "whatever `main` happened to be when each person installed"):
   ```bash
   omp plugin install github:sinanawad/omp-bash-gate#v0.2.0
   ```
3. **Have each person configure a classifier model** with `/bash-gate`. Each teammate uses whichever provider *they* have authenticated — there is no shared key and no required provider. Alternatively, standardise via env var: `export BASH_GATE_MODEL=anthropic/claude-haiku-4.5`.
4. **Agree on the approval posture.** The safe default is to leave omp's native bash approval on (see below). If the team opts into `yolo` + `bash: allow`, make sure everyone knows to revert it if they ever remove the plugin.
5. **Verify** after restart: the startup banner shows `🛡️ bash-gate v0.2.0 active — classifier: <model>`. Its absence means the gate is not loaded.

Private repos work the same way, as long as each machine's git credentials can clone the repo.

## Uninstall / Disable

1. Remove the plugin:
   - Option A: `omp plugin uninstall omp-bash-gate`
   - Option B: delete the `extensions:` entry from `~/.omp/agent/config.yml`
   - Option C: delete `~/.omp/agent/extensions/bash-gate.ts`
2. **If you set `yolo` + `bash: allow`**, revert it so bash is not left auto-approved — delete the `tools.approval.bash` key or set it back to `prompt`.

## Privacy & security notes

This extension is a policy and confirmation layer, **not** an OS-level sandbox. Shell parsing is complex and pattern-based classification cannot prove that an unmatched command is safe. Run omp in an isolated environment when executing untrusted code.

When a classifier model is configured, the text of an ambiguous (tier-3) command is sent to that model's provider. Bash commands sometimes contain secrets (passwords, tokens, connection strings). The gate makes a best-effort pass to redact obvious credentials before sending, but this is a safety net, not a guarantee — treat the classifier provider as you would any place your commands are sent. To avoid any network classification entirely, leave the model unconfigured: safe/dangerous commands are still handled deterministically and everything else prompts locally.

The allowlist is intentionally conservative. If you extend it, edit the tier-1 grammar in `src/bash-gate.ts`, and do not add state-changing commands (`rm`, `mv`, `curl`, …) — those should go through the classifier.

## Develop & test

```bash
bun install
bun run typecheck   # tsc --noEmit against omp's real typedefs
bun test            # mocked classifier — no API key or network needed
bun run check       # typecheck + test
```

## License

MIT
