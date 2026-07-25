# Agent instructions for omp-bash-gate

## Never execute a destructive-pattern command live to verify the gate

This extension's job is to intercept commands like `rm -rf /`, `mkfs /dev/sda1`,
`dd of=/dev/sda`, and fork bombs before they run. Verifying those patterns by
actually running them in a real shell means betting the target filesystem/disk
on the gate having zero bugs — if the extension fails to load, has a regex
gap, or crashes, the "test" is now the real destructive action with nothing
left to stop it.

**Rule: verify blocklist/dangerous-pattern coverage only through `bun test`
(mocked `tool_call` handler invocation) or static code reading — never by
issuing the actual command through a live shell.**

This applies even when a fake/nonexistent target is used for commands like
`mkfs` or `dd` (safe substitution works there because the pattern matches on
the command shape, not the target's existence) — it does **not** apply to
`rm -rf /` or similar root/recursive-delete patterns, where any live
invocation *is* the dangerous action regardless of what target you pick.

Safe verification pattern for a new dangerous-pattern regex:

```bash
cd omp-bash-gate && bun test  # exercises the pattern via the mocked handler
```

If you need to confirm end-to-end behavior in a running omp session, use a
tier-1/tier-3 command that is harmless even if the gate fails open (e.g.
`sleep 1`, `ls`, a `python3 -c` snippet against a nonexistent path) — never a
tier-2 blocklist pattern whose live execution is itself catastrophic.

## Commit trailers

No `Co-Authored-By` or AI-attribution trailers. Commits are authored solely
by the human maintainer.
