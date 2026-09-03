import { describe, expect, it } from "bun:test";
import {
  extractEventUsage,
  formatHudEmbed,
  formatToolExecutionEmbed,
  formatToolOutputPreview,
  formatToolSummary,
  formatToolTracesEmbed,
  mergeHudState,
  readModelDisplay,
  readTokenUsage,
  type HudState,
  type ToolExecutionTrace,
} from "./observability";
import type { SessionContext } from "./session-manager";
describe("observability HUD formatting", () => {
  it("renders model, reasoning, token breakdown, context and git state", () => {
    const state: HudState = {
      model: "anthropic/claude-3-7-sonnet",
      reasoningLevel: "high",
      tokens: {
        input: 12500,
        output: 3200,
        total: 15700,
        contextWindow: 200000,
        contextPercent: 7.85,
      },
      activeSubagents: ["planner", "critic"],
      activeTool: "🔧 bash",
      branch: "feat/observability",
      gitDirty: true,
      cwd: "/workspace/project",
      turnStatus: "running",
      updatedAt: 1710000000000,
    };

    const embed = formatHudEmbed(state);
    const json = embed.toJSON();
    expect(json.title).toBe("📡 OMP Live HUD");
    expect(json.color).toBe(0xf1c40f);
    expect(json.fields?.find((f) => f.name === "🤖 Model • Reasoning")?.value).toContain("claude-3-7-sonnet");
    expect(json.fields?.find((f) => f.name === "🤖 Model • Reasoning")?.value).toContain("high");
    expect(json.fields?.find((f) => f.name === "📥 Input Tokens")?.value).toBe("12,500");
    expect(json.fields?.find((f) => f.name === "🌿 Git")?.value).toContain("feat/observability • uncommitted changes");
    expect(json.fields?.find((f) => f.name === "🤖 Active Subagents")?.value).toBe("planner, critic");
  });
});

describe("tool execution trace formatting", () => {
  it("renders icon, status, duration, exit status and concise output", () => {
    const trace: ToolExecutionTrace = {
      id: "trace_1",
      toolName: "bash",
      args: { command: "git status" },
      intent: "Checking modified files",
      phase: "completed",
      startedAt: Date.now() - 2500,
      endedAt: Date.now(),
      durationMs: 2500,
      exitCode: 0,
      outputPreview: "On branch main\nnothing to commit",
    };

    const embed = formatToolExecutionEmbed(trace);
    const json = embed.toJSON();
    expect(json.title).toBe("🔨 bash");
    expect(json.fields?.find((f) => f.name === "Status")?.value).toContain("Completed");
    expect(json.fields?.find((f) => f.name === "Duration")?.value).toBe("2.50s");
    expect(json.fields?.find((f) => f.name === "Exit")?.value).toBe("0");
    expect(json.fields?.find((f) => f.name === "Intent")?.value).toBe("Checking modified files");
  });
});

describe("multi-tool execution trace formatting (single message)", () => {
  it("renders an empty traces placeholder gracefully", () => {
    const embed = formatToolTracesEmbed([]);
    const json = embed.toJSON();
    expect(json.title).toBe("🛠️ Tool Traces");
    expect(json.description).toContain("No tool calls recorded.");
  });

  it("renders single trace identically to formatToolExecutionEmbed", () => {
    const trace: ToolExecutionTrace = {
      id: "trace_single",
      toolName: "read",
      args: { path: "src/index.ts" },
      phase: "running",
      startedAt: Date.now(),
    };
    const embed = formatToolTracesEmbed([trace]);
    const json = embed.toJSON();
    expect(json.title).toBe("📖 read");
    expect(json.fields?.find((f) => f.name === "Status")?.value).toContain("Running");
  });

  it("renders multiple tools with running status, execution list and active tool details", () => {
    const traces: ToolExecutionTrace[] = [
      {
        id: "t1",
        toolName: "grep",
        args: { pattern: "TODO" },
        phase: "completed",
        startedAt: 1000,
        endedAt: 2000,
        durationMs: 1000,
        exitCode: 0,
        outputPreview: "found 2 matches",
      },
      {
        id: "t2",
        toolName: "read",
        args: { path: "src/main.ts" },
        intent: "Reading main entry point",
        phase: "completed",
        startedAt: 2000,
        endedAt: 2500,
        durationMs: 500,
        exitCode: 0,
      },
      {
        id: "t3",
        toolName: "edit",
        args: { path: "src/main.ts" },
        intent: "Applying patch",
        phase: "running",
        startedAt: 2500,
      },
    ];

    const embed = formatToolTracesEmbed(traces);
    const json = embed.toJSON();
    expect(json.title).toContain("🛠️ Tool Traces (3) • ✏️ edit");
    expect(json.color).toBe(0xf1c40f);
    expect(json.description).toContain("1. ✅ 🔍 **grep** (1.00s)");
    expect(json.description).toContain("2. ✅ 📖 **read** (0.50s) — `Reading main entry point`");
    expect(json.description).toContain("3. ⏳ ✏️ **edit** (running) — `Applying patch`");
    expect(json.fields?.find((f) => f.name.includes("Active Tool"))?.value).toContain("⏳ Running");
  });

  it("renders failed status and color when a tool fails", () => {
    const traces: ToolExecutionTrace[] = [
      {
        id: "t1",
        toolName: "bash",
        args: { command: "npm test" },
        phase: "failed",
        startedAt: 1000,
        endedAt: 3000,
        durationMs: 2000,
        exitCode: 1,
        error: "3 tests failed",
      },
    ];

    const embed = formatToolTracesEmbed(traces);
    const json = embed.toJSON();
    expect(json.title).toBe("🔨 bash");
    expect(json.color).toBe(0xed4245);
    expect(json.fields?.find((f) => f.name === "Status")?.value).toContain("Failed");
    expect(json.fields?.find((f) => f.name === "Error")?.value).toBe("3 tests failed");
  });

  it("truncates list description gracefully when exceeding 10 tools", () => {
    const traces: ToolExecutionTrace[] = Array.from({ length: 15 }, (_, i) => ({
      id: `t_${ i }`,
      toolName: "read",
      args: { path: `file_${ i }.ts` },
      phase: "completed" as const,
      startedAt: 1000 * i,
      endedAt: 1000 * i + 200,
      durationMs: 200,
    }));

    const embed = formatToolTracesEmbed(traces);
    const json = embed.toJSON();
    expect(json.title).toContain("15 completed");
    expect(json.description).toContain("5 earlier tool calls omitted");
    expect(json.description).toContain("15. ✅ 📖 **read** (0.20s)");
  });

  it("formats tool summary for various argument formats", () => {
    expect(formatToolSummary({ id: "1", toolName: "bash", phase: "completed", startedAt: 0, intent: "Custom Intent" })).toBe("Custom Intent");
    expect(formatToolSummary({ id: "2", toolName: "bash", phase: "completed", startedAt: 0, args: { command: "git diff" } })).toBe("git diff");
    expect(formatToolSummary({ id: "3", toolName: "read", phase: "completed", startedAt: 0, args: { path: "src/app.ts" } })).toBe("src/app.ts");
    expect(formatToolSummary({ id: "4", toolName: "grep", phase: "completed", startedAt: 0, args: { pattern: "foo.*bar" } })).toBe("pattern: foo.*bar");
  });
});

describe("model display formatting", () => {
  it("formats string model correctly", () => {
    expect(readModelDisplay({ model: "openai/gpt-5.6-luna" })).toBe("openai/gpt-5.6-luna");
  });

  it("formats provider, id, and name when id and name differ", () => {
    expect(
      readModelDisplay({
        model: {
          id: "openai/gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "litellm",
        },
      }),
    ).toBe("litellm/openai/gpt-5.6-luna (GPT-5.6 Luna)");
  });

  it("avoids repeating name when id equals name", () => {
    expect(
      readModelDisplay({
        model: {
          id: "antigravity/gemini-3.8-flash-high",
          name: "antigravity/gemini-3.8-flash-high",
          provider: "litellm",
        },
      }),
    ).toBe("litellm/antigravity/gemini-3.8-flash-high");
  });

  it("handles model object passed directly as root data", () => {
    expect(
      readModelDisplay({
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "openai",
      }),
    ).toBe("openai/gpt-4o (GPT-4o)");
  });
});

describe("event usage extraction", () => {
  it("extracts usage from turn_end message.usage", () => {
    const event = {
      type: "turn_end",
      message: {
        role: "assistant",
        usage: {
          input: 5952,
          output: 42,
          cacheRead: 20417,
          totalTokens: 26411,
        },
      },
    };
    expect(extractEventUsage(event)).toEqual({
      input: 5952,
      output: 42,
      total: 26411,
    });
  });

  it("extracts usage from agent_end messages array", () => {
    const event = {
      type: "agent_end",
      messages: [
        { role: "user", content: "test" },
        {
          role: "assistant",
          usage: {
            input: 8100,
            output: 250,
            totalTokens: 8350,
          },
        },
      ],
    };
    expect(extractEventUsage(event)).toEqual({
      input: 8100,
      output: 250,
      total: 8350,
    });
  });

  it("returns undefined when no usage is present", () => {
    expect(extractEventUsage({ type: "turn_end" })).toBeUndefined();
  });
});

describe("HUD state merging and token persistence", () => {
  function createFakeSession(): SessionContext {
    return {
      process: {} as unknown as SessionContext["process"],
      threadId: "t1",
      cwd: "/workspace",
      currentStreamBuffer: "",
      lastEditTimestamp: 0,
      cumulativeTokens: { input: 15000, output: 850 },
      activeSubagentsMap: new Map([["sub1", { id: "sub1", agent: "scout" }]]),
      hudState: {
        model: "openai/gpt-5.2",
        reasoningLevel: "low",
        tokens: {
          input: 15000,
          output: 850,
          total: 15850,
          contextWindow: 200000,
          contextPercent: 7.9,
        },
        activeSubagents: ["scout"],
        cwd: "/workspace",
      },
    };
  }

  it("preserves cumulative tokens when get_state returns only contextUsage", () => {
    const session = createFakeSession();
    const getStateData = {
      contextUsage: {
        tokens: 34200,
        contextWindow: 1048576,
        percent: 3.26,
      },
      model: {
        id: "openai/gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "litellm",
      },
      thinkingLevel: "high",
    };

    const merged = mergeHudState(session, getStateData);
    expect(merged.tokens?.input).toBe(15000);
    expect(merged.tokens?.output).toBe(850);
    expect(merged.tokens?.total).toBe(34200);
    expect(merged.tokens?.contextWindow).toBe(1048576);
    expect(merged.tokens?.contextPercent).toBe(3.26);
    expect(merged.model).toBe("litellm/openai/gpt-5.6-luna (GPT-5.6 Luna)");
    expect(merged.reasoningLevel).toBe("high");
    expect(merged.activeSubagents).toEqual(["scout"]);
  });
});
