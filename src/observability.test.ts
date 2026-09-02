import { describe, expect, it } from "bun:test";
import {
  formatHudEmbed,
  formatToolExecutionEmbed,
  formatToolOutputPreview,
  formatToolSummary,
  formatToolTracesEmbed,
  type HudState,
  type ToolExecutionTrace,
} from "./observability";

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
    expect(json.fields?.find((f) => f.name === "Output Preview")?.value).toContain("nothing to commit");
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
      id: `t_${i}`,
      toolName: "read",
      args: { path: `file_${i}.ts` },
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
