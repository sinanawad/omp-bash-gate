import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Bash safety gate — model-assisted command classification.
 *
 * Three-tier classification with fail-closed semantics:
 *   1. Allowlist  — instant allow, no LLM call. Trivially safe commands
 *      (ls, cat, grep, git status, pwd, head, tail, wc, find, etc.).
 *   2. Blocklist  — instant block, no LLM call. Genuinely destructive
 *      patterns (rm -rf /, dd of=, mkfs, fork bombs, > /etc/, chmod 777).
 *   3. Model      — everything else gets a small/fast model call that
 *      returns safe|risky|dangerous. In the primary session, risky prompts
 *      the user; in subagents (no UI), risky blocks.
 *
 * Fail-safe: if the model call fails or times out, retry once, then block.
 *
 * Configuration (precedence: state file > env var > default):
 *   BASH_GATE_MODEL        — model id for classification (default: anthropic/claude-haiku-4.5)
 *   BASH_GATE_TIMEOUT_MS   — API call timeout in ms (default: 5000)
 *   BASH_GATE_MAX_TOKENS   — max output tokens for classifier (default: 16)
 *   BASH_GATE_DEBUG        — set to "1" for verbose logging (default: off)
 *
 * State file: ~/.omp/agent/bash-gate.json
 *   { "model": "anthropic/claude-haiku-4.5" }
 *
 * Slash command: /bash-gate — interactive model selection.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const STATE_FILE = join(
  process.env.HOME ?? "",
  ".omp",
  "agent",
  "bash-gate.json",
);

type GateConfig = { model?: string };

function loadConfig(): GateConfig {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as GateConfig;
      if (parsed && typeof parsed.model === "string") return parsed;
    }
  } catch {
    // ignore — fall through to defaults
  }
  return {};
}

function saveConfig(cfg: GateConfig): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

const ALLOW_PATTERNS: RegExp[] = [
  /^\s*(ls|cat|head|tail|wc|file|stat|du|df|which|command -v)\b/,
  /^\s*(pwd)\b/,
  /^\s*(grep|rg|ag|ack)\b/,
  /^\s*(find|fd)\b(?!.*-(?:exec|delete|okdir))/,
  /^\s*(git status|git diff|git log|git show|git branch|git remote)\b/,
  /^\s*(echo|printf|true|false|date|whoami|uname|hostname)\b/,
  /^\s*(env|printenv)\b/,
  /^\s*(cd)\b/,
];

const BLOCK_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(\s|$)/,
  /:\s*\(\s*\)\s*\{\s*:\s*\|:\s*&\s*\}\s*;/,
  /\bdd\b.*\bof\s*=\s*\/dev\//,
  /\bmkfs(\.\w+)?\s+\/dev\//,
  />\s*\/etc\/(passwd|shadow|sudoers|fstab|hosts)\b/,
  /\bchmod\s+-?R?\s*777\b/,
  /\bchown\s+-R\b.*\/\s*$/,
  /\b(shutdown|reboot|poweroff)\b/,
  /\b>\s*\/dev\/sd[a-z]/,
];

const FILE_CONFIG = loadConfig();
const MODEL =
  FILE_CONFIG.model ??
  process.env.BASH_GATE_MODEL ??
  "anthropic/claude-haiku-4.5";
const REQUEST_TIMEOUT_MS = Number(process.env.BASH_GATE_TIMEOUT_MS ?? 5000);
const MAX_TOKENS = Number(process.env.BASH_GATE_MAX_TOKENS ?? 16);
const DEBUG = process.env.BASH_GATE_DEBUG === "1";

let timeoutCount = 0;

type ClassifierResult = "safe" | "risky" | "dangerous" | null;
type ApiKeyHolder = { apiKey?: string; key?: string };
type ModelRegistryLike = {
  getApiKeyForProvider?: (p: string) => Promise<unknown>;
};
type ToolCallEvent = {
  toolName?: string;
  input?: { command?: unknown };
};
type HookCtx = {
  hasUI?: boolean;
  ui?: {
    confirm?: (title: string, message: string) => Promise<boolean>;
    notify?: (message: string, type: string) => void;
  };
  modelRegistry?: ModelRegistryLike;
};

async function classifyWithModel(
  ctx: HookCtx,
  logger: { info?: (m: string) => void; warn?: (m: string) => void },
  command: string,
): Promise<ClassifierResult> {
  const reg = ctx.modelRegistry;
  if (!reg || typeof reg.getApiKeyForProvider !== "function") {
    logger.warn?.("bash-gate: no modelRegistry or getApiKeyForProvider");
    return null;
  }

  let apiKey: string | undefined;
  try {
    const k: unknown = await reg.getApiKeyForProvider("openrouter");
    if (typeof k === "string") {
      apiKey = k;
    } else if (k && typeof k === "object") {
      const holder = k as ApiKeyHolder;
      apiKey = holder.apiKey ?? holder.key;
    }
  } catch (e) {
    logger.warn?.(`bash-gate: getApiKeyForProvider threw: ${String(e)}`);
    return null;
  }
  if (!apiKey) {
    logger.warn?.("bash-gate: no apiKey resolved for openrouter");
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "Output exactly one word — safe, risky, or dangerous — and nothing else. No explanation. 'safe' = read-only or idempotent. 'risky' = modifies files/state but reversible. 'dangerous' = destructive, irreversible, or system-level. Examples:\ninput: ls\noutput: safe\ninput: rm file\noutput: risky\ninput: rm -rf /\noutput: dangerous",
          },
          { role: "user", content: command.slice(0, 4000) },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn?.(`bash-gate: fetch non-ok status=${res.status}`);
      return null;
    }
    const data: unknown = await res.json();
    const choices =
      (data as { choices?: Array<{ message?: { content?: string } }> })?.choices ??
      [];
    const text: string = choices[0]?.message?.content ?? "";
    const clean = text.trim().toLowerCase();
    if (clean.startsWith("safe")) return "safe";
    if (clean.startsWith("risky")) return "risky";
    if (clean.startsWith("dangerous")) return "dangerous";
    logger.warn?.(
      `bash-gate: unrecognized model output: ${JSON.stringify(text).slice(0, 120)}`,
    );
    return null;
  } catch (e) {
    logger.warn?.(`bash-gate: fetch threw: ${String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Model options for the /bash-gate slash command.
const MODEL_OPTIONS = [
  {
    label: "Claude Haiku 4.5 (recommended — non-thinking, cheap, reliable)",
    value: "anthropic/claude-haiku-4.5",
  },
  {
    label: "Kimi K2 (non-thinking, budget)",
    value: "moonshotai/kimi-k2",
  },
  {
    label: "DeepSeek V4 Pro (thinking — may truncate)",
    value: "deepseek/deepseek-v4-pro",
  },
  {
    label: "Gemini 3.5 Flash (thinking — may truncate)",
    value: "google/gemini-3.5-flash",
  },
];

export default function (pi: ExtensionAPI) {
  if (DEBUG) pi.logger?.info?.(`bash-gate: loaded (model=${MODEL})`);

  pi.on("tool_call", async (event: ToolCallEvent, ctx: HookCtx) => {
    if (event.toolName !== "bash") return;
    const cmd: string = String(event.input?.command ?? "");
    if (!cmd.trim()) return;

    if (ALLOW_PATTERNS.some((p) => p.test(cmd))) {
      if (DEBUG) pi.logger?.info?.(`bash-gate: allowlist: ${cmd.slice(0, 80)}`);
      return;
    }

    if (BLOCK_PATTERNS.some((p) => p.test(cmd))) {
      ctx.ui?.notify?.(
        `⛔ BLOCKED (dangerous pattern): ${cmd.slice(0, 100)}`,
        "error",
      );
      return { block: true, reason: "Blocked by safety hook: dangerous pattern" };
    }

    ctx.ui?.setStatus?.("bash-gate", `🤔 classifying: ${cmd.slice(0, 60)}`);
    const verdict = await classifyWithModel(ctx, pi.logger, cmd);
    if (DEBUG)
      pi.logger?.info?.(
        `bash-gate: tier3 verdict="${verdict}" cmd="${cmd.slice(0, 60)}"`,
      );
    ctx.ui?.setStatus?.("bash-gate", "");

    // Resolve the final verdict — retry once if the first call fails.
    let final = verdict;
    if (final === null) {
      timeoutCount++;
      if (timeoutCount === 3) {
        pi.logger?.warn?.(
          "bash-gate: 3 consecutive model-check failures — check OpenRouter connectivity or model availability",
        );
      }
      final = await classifyWithModel(ctx, pi.logger, cmd);
      if (final === null) {
        ctx.ui?.notify?.(
          `⛔ BLOCKED (check failed): ${cmd.slice(0, 100)}`,
          "error",
        );
        return {
          block: true,
          reason: "Blocked: could not verify command safety (model check failed)",
        };
      }
    }
    timeoutCount = 0;

    if (final === "safe") {
      ctx.ui?.notify?.(`✅ ALLOWED (safe): ${cmd.slice(0, 100)}`, "info");
      return;
    }

    if (final === "dangerous") {
      ctx.ui?.notify?.(
        `⛔ BLOCKED (dangerous): ${cmd.slice(0, 100)}`,
        "error",
      );
      return { block: true, reason: "Blocked by model: classified as dangerous" };
    }

    // final === "risky"
    ctx.ui?.notify?.(`⚠️ PROMPTING (risky): ${cmd.slice(0, 100)}`, "error");
    if (ctx.hasUI && ctx.ui?.confirm) {
      const ok = await ctx.ui.confirm(
        "⚠️ Risky bash command",
        `Allow this command?\n\n${cmd.slice(0, 500)}`,
      );
      if (ok) return;
      return { block: true, reason: "User denied risky command" };
    }
    return {
      block: true,
      reason: "Blocked: risky command in subagent (no UI to confirm)",
    };
  });

  pi.registerCommand("bash-gate", {
    description: "Configure the bash safety gate model",
    handler: async (_args: string, ctx: {
      hasUI?: boolean;
      ui?: {
        select?: (
          title: string,
          options: string[],
        ) => Promise<string | null>;
        notify?: (message: string, type: string) => void;
      };
    }) => {
      if (!ctx.hasUI || !ctx.ui?.select) {
        pi.logger?.info?.(
          `bash-gate: current model=${MODEL} (no UI to change)`,
        );
        return;
      }

      const selected = await ctx.ui.select(
        "Bash gate: choose classifier model",
        MODEL_OPTIONS.map((o) => o.label),
      );

      if (selected === null || selected === undefined) return;

      const match = MODEL_OPTIONS.find((o) => o.label === selected);
      if (!match) return;

      saveConfig({ model: match.value });
      ctx.ui?.notify?.(
        `bash-gate: model set to ${match.value} — restart omp to apply`,
        "info",
      );
      pi.logger?.info?.(
        `bash-gate: model changed to ${match.value} (restart required)`,
      );
    },
  });
}
