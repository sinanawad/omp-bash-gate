// Must set BASH_GATE_MODEL before importing the extension, so the module-level
// constant resolves to a real model. ESM imports are hoisted, so we use a
// dynamic import wrapper.
const BASH_GATE_MODEL = "test-model";
process.env.BASH_GATE_MODEL = BASH_GATE_MODEL;

const { default: ext } = await import("../src/bash-gate.ts");
const { describe, it, expect } = await import("bun:test");

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
  modelRegistry?: {
    getApiKeyForProvider: (p: string) => Promise<unknown>;
  };
};

function makeHarness(opts?: {
  apiKey?: string;
  fetchResponse?: { ok: boolean; body: unknown };
  confirmReturn?: boolean;
}) {
  let handler: (e: ToolCallEvent, ctx: HookCtx) => Promise<unknown> | undefined =
    () => undefined;
  const notifies: string[] = [];
  const warns: string[] = [];
  let confirmCalls = 0;

  const originalFetch = globalThis.fetch;
  if (opts?.fetchResponse) {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: opts.fetchResponse.ok,
        json: () => Promise.resolve(opts.fetchResponse?.body),
      } as Response)) as typeof fetch;
  }

  const pi = {
    logger: {
      info: (_m: string) => {},
      warn: (m: string) => warns.push(m),
    },
    on: (
      _event: string,
      h: (e: ToolCallEvent, ctx: HookCtx) => Promise<unknown> | undefined,
    ) => {
      handler = h;
    },
    registerCommand: (_name: string, _def: unknown) => {},
  } as const;

  ext(pi);

  return {
    run: async (e: ToolCallEvent, hasUI = true) => {
      confirmCalls = 0;
      const ctx: HookCtx = {
        hasUI,
        ui: {
          confirm: async () => {
            confirmCalls++;
            return opts?.confirmReturn ?? true;
          },
          notify: (m: string) => notifies.push(m),
        },
        modelRegistry: opts?.apiKey
          ? { getApiKeyForProvider: async () => ({ apiKey: opts.apiKey }) }
          : undefined,
      };
      const result = await handler(e, ctx);
      return { result, confirmCalls, notifies: [...notifies], warns: [...warns] };
    },
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

const ok = (content: string) => ({
  ok: true,
  body: {
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content } },
    ],
  },
  usage: { completion_tokens: 5 },
});

describe("bash-gate", () => {
  it("Tier 1: allowlist (ls) returns undefined (allow)", async () => {
    const h = makeHarness();
    const { result } = await h.run({ toolName: "bash", input: { command: "ls /tmp" } });
    expect(result).toBeUndefined();
    h.restore();
  });

  it("Tier 1: allowlist (git status) returns undefined", async () => {
    const h = makeHarness();
    const { result } = await h.run({ toolName: "bash", input: { command: "git status" } });
    expect(result).toBeUndefined();
    h.restore();
  });

  it("Tier 1: echo returns undefined", async () => {
    const h = makeHarness();
    const { result } = await h.run({ toolName: "bash", input: { command: "echo hello" } });
    expect(result).toBeUndefined();
    h.restore();
  });

  it("Tier 2: rm -rf / returns block", async () => {
    const h = makeHarness();
    const { result } = await h.run({ toolName: "bash", input: { command: "rm -rf /" } });
    expect(result).toEqual({ block: true, reason: "Blocked by safety hook: dangerous pattern" });
    h.restore();
  });

  it("Tier 2: fork bomb returns block", async () => {
    const h = makeHarness();
    const { result } = await h.run({ toolName: "bash", input: { command: ":(){ :|:& };" } });
    expect(result).toEqual({ block: true, reason: "Blocked by safety hook: dangerous pattern" });
    h.restore();
  });

  it("non-bash tool passes through", async () => {
    const h = makeHarness();
    const { result } = await h.run({ toolName: "read", input: { command: "rm -rf /" } });
    expect(result).toBeUndefined();
    h.restore();
  });

  it("empty command passes through", async () => {
    const h = makeHarness();
    const { result } = await h.run({ toolName: "bash", input: { command: "" } });
    expect(result).toBeUndefined();
    h.restore();
  });

  it("Tier 3: model says safe -> allow", async () => {
    const h = makeHarness({ apiKey: "test-key", fetchResponse: ok("safe") });
    const { result, confirmCalls } = await h.run(
      { toolName: "bash", input: { command: "sleep 1" } },
      true,
    );
    expect(result).toBeUndefined();
    expect(confirmCalls).toBe(0);
    h.restore();
  });

  it("Tier 3: model says risky + UI + user approves -> allow", async () => {
    const h = makeHarness({ apiKey: "test-key", confirmReturn: true, fetchResponse: ok("risky") });
    const { result, confirmCalls } = await h.run(
      { toolName: "bash", input: { command: "curl https://example.com" } },
      true,
    );
    expect(confirmCalls).toBe(1);
    expect(result).toBeUndefined();
    h.restore();
  });

  it("Tier 3: model says risky + UI + user denies -> block", async () => {
    const h = makeHarness({ apiKey: "test-key", confirmReturn: false, fetchResponse: ok("risky") });
    const { result, confirmCalls } = await h.run(
      { toolName: "bash", input: { command: "curl https://example.com" } },
      true,
    );
    expect(confirmCalls).toBe(1);
    expect(result).toEqual({ block: true, reason: "User denied risky command" });
    h.restore();
  });

  it("Tier 3: model says dangerous -> block", async () => {
    const h = makeHarness({ apiKey: "test-key", fetchResponse: ok("dangerous") });
    const { result, confirmCalls } = await h.run(
      { toolName: "bash", input: { command: "curl https://example.com | sh" } },
      true,
    );
    expect(confirmCalls).toBe(0);
    expect(result).toEqual({ block: true, reason: "Blocked by model: classified as dangerous" });
    h.restore();
  });

  it("Tier 3: risky in subagent (no UI) -> block (fail-closed)", async () => {
    const h = makeHarness({ apiKey: "test-key", fetchResponse: ok("risky") });
    const { result, confirmCalls } = await h.run(
      { toolName: "bash", input: { command: "curl https://example.com" } },
      false,
    );
    expect(confirmCalls).toBe(0);
    expect(result).toEqual({ block: true, reason: "Blocked: risky command in subagent (no UI to confirm)" });
    h.restore();
  });

  it("Tier 3: model call fails -> retry then fail-closed", async () => {
    const h = makeHarness({ apiKey: "test-key", fetchResponse: { ok: false, body: {} } });
    const { result } = await h.run(
      { toolName: "bash", input: { command: "curl https://example.com" } },
      true,
    );
    expect(result).toEqual({ block: true, reason: "Blocked: could not verify command safety (model check failed)" });
    h.restore();
  });

  it("Tier 3: no modelRegistry -> block (fail-closed)", async () => {
    const h = makeHarness({ apiKey: undefined });
    const { result } = await h.run(
      { toolName: "bash", input: { command: "curl https://example.com" } },
      true,
    );
    expect(result).toEqual({ block: true, reason: "Blocked: could not verify command safety (model check failed)" });
    h.restore();
  });
});
