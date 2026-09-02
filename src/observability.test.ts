import { describe, expect, it } from "bun:test";
import {
  createVisualVerdictEmbed,
  createVisualVerdictResponse,
  createVisualVerdictRow,
  extractVisualArtifact,
  formatHudEmbed,
  formatToolExecutionEmbed,
  formatToolOutputPreview,
  formatToolSummary,
  formatToolTracesEmbed,
  parseVisualVerdictCustomId,
  type HudState,
  type ToolExecutionTrace,
} from "./observability";

describe("observability HUD formatting", () => {
  it("renders model, reasoning, token breakdown, context and git state", () => {
    const state: HudState = {
      model: "openai/gpt-5.5",
      reasoningLevel: "High",
      tokens: { input: 1200, output: 345, total: 1545, contextWindow: 8192, contextPercent: 0.19 },
      activeSubagents: ["reviewer", "scout"],
      activeTool: "🔨 bash",
      branch: "feat/observability",
      gitDirty: true,
      cwd: "/workspace/project",
    };
    const json = formatHudEmbed(state).toJSON();
    const fields = json.fields || [];
    const values = fields.map((field) => `${field.name}: ${field.value}`).join("\n");

    expect(json.title).toBe("📡 OMP Live HUD");
    expect(values).toContain("openai/gpt-5.5");
    expect(values).toContain("High");
    expect(values).toContain("1,200");
    expect(values).toContain("345");
    expect(values).toContain("1,545");
    expect(values).toContain("19%");
    expect(values).toContain("uncommitted changes");
    expect(values).toContain("reviewer, scout");
  });
});

describe("tool execution trace formatting", () => {
  it("renders icon, status, duration, exit status and concise output", () => {
    const trace: ToolExecutionTrace = {
      id: "exec-1",
      toolName: "bash",
      args: { command: "bun test" },
      phase: "completed",
      startedAt: 1000,
      endedAt: 2350,
      durationMs: 1350,
      exitCode: 0,
      outputPreview: "All tests passed",
    };
    const json = formatToolExecutionEmbed(trace).toJSON();
    const fields = json.fields || [];
    const values = fields.map((field) => `${field.name}: ${field.value}`).join("\n");

    expect(json.title).toBe("🔨 bash");
    expect(values).toContain("Completed");
    expect(values).toContain("1.35s");
    expect(values).toContain("Exit: 0");
    expect(values).toContain("All tests passed");
    expect(formatToolOutputPreview("x".repeat(900)).length).toBeLessThanOrEqual(700);
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
      id: "call_single",
      toolName: "read",
      phase: "completed",
      startedAt: 1700000000000,
      endedAt: 1700000000050,
      durationMs: 50,
      args: { path: "src/index.ts" },
      outputPreview: "import ...",
    };
    const json = formatToolTracesEmbed([trace]).toJSON();
    expect(json.title).toBe("📖 read");
    const values = (json.fields || []).map((f) => `${f.name}: ${f.value}`).join("\n");
    expect(values).toContain("Completed");
    expect(values).toContain("0.05s");
    expect(json.footer?.text).toBe("Trace call_single");
  });

  it("renders multiple tools with running status, execution list and active tool details", () => {
    const traces: ToolExecutionTrace[] = [
      {
        id: "call_1",
        toolName: "read",
        phase: "completed",
        startedAt: 1700000000000,
        endedAt: 1700000000100,
        durationMs: 100,
        args: { path: "src/index.ts" },
      },
      {
        id: "call_2",
        toolName: "grep",
        phase: "completed",
        startedAt: 1700000000200,
        endedAt: 1700000000450,
        durationMs: 250,
        args: { pattern: "tool_execution" },
      },
      {
        id: "call_3",
        toolName: "bash",
        phase: "running",
        startedAt: 1700000000500,
        args: { command: "bun test" },
        intent: "Running verification suite",
      },
    ];

    const json = formatToolTracesEmbed(traces).toJSON();
    expect(json.title).toContain("Tool Traces (3)");
    expect(json.title).toContain("bash");
    expect(json.description).toContain("1. ✅ 📖 **read** (0.10s)");
    expect(json.description).toContain("2. ✅ 🔍 **grep** (0.25s)");
    expect(json.description).toContain("3. ⏳ 🔨 **bash** (running)");

    const fields = json.fields || [];
    const activeField = fields.find((f) => f.name.includes("Active Tool"));
    expect(activeField).toBeDefined();
    expect(activeField?.value).toContain("Running");

    const inputField = fields.find((f) => f.name === "Input");
    expect(inputField?.value).toContain("bun test");

    const intentField = fields.find((f) => f.name === "Intent");
    expect(intentField?.value).toBe("Running verification suite");
  });

  it("renders failed status and color when a tool fails", () => {
    const traces: ToolExecutionTrace[] = [
      {
        id: "call_1",
        toolName: "bash",
        phase: "failed",
        startedAt: 1700000000000,
        endedAt: 1700000001000,
        durationMs: 1000,
        exitCode: 1,
        error: "Command failed with exit code 1",
      },
    ];

    const json = formatToolTracesEmbed(traces).toJSON();
    expect(json.color).toBe(0xed4245);
    const values = (json.fields || []).map((f) => `${f.name}: ${f.value}`).join("\n");
    expect(values).toContain("Failed");
    expect(values).toContain("Command failed with exit code 1");
  });

  it("truncates list description gracefully when exceeding 10 tools", () => {
    const traces: ToolExecutionTrace[] = Array.from({ length: 15 }, (_, i) => ({
      id: `call_${i + 1}`,
      toolName: "read",
      phase: "completed" as const,
      startedAt: 1700000000000 + i * 100,
      endedAt: 1700000000050 + i * 100,
      durationMs: 50,
      args: { path: `src/file${i + 1}.ts` },
    }));

    const json = formatToolTracesEmbed(traces).toJSON();
    expect(json.title).toBe("🛠️ Tool Traces (15 completed)");
    expect(json.description).toContain("5 earlier tool calls omitted");
    expect(json.description).toContain("15. ✅ 📖 **read**");
    expect(json.footer?.text).toContain("15 tool calls in turn");
  });

  it("formats tool summary for various argument formats", () => {
    expect(formatToolSummary({ id: "1", toolName: "bash", phase: "running", startedAt: 0, intent: "Run tests" })).toBe("Run tests");
    expect(formatToolSummary({ id: "2", toolName: "bash", phase: "running", startedAt: 0, args: { command: "git status" } })).toBe("git status");
    expect(formatToolSummary({ id: "3", toolName: "read", phase: "running", startedAt: 0, args: { path: "foo.ts" } })).toBe("foo.ts");
    expect(formatToolSummary({ id: "4", toolName: "grep", phase: "running", startedAt: 0, args: { pattern: "abc" } })).toBe("pattern: abc");
  });
});

describe("visual artifact verdict handlers", () => {
  it("finds nested screenshot artifacts and creates interactive verdict controls", () => {
    const artifact = extractVisualArtifact({ result: { screenshot: { path: "/tmp/ui.png", mimeType: "image/png" } } }, "visual-1");
    expect(artifact).toEqual({
      id: "visual-1",
      source: "/tmp/ui.png",
      sourceType: "path",
      name: "visual-1.png",
      mimeType: "image/png",
    });

    const row = createVisualVerdictRow("visual-1");
    const components = row.toJSON().components as Array<{ label?: string; custom_id?: string }>;
    expect(components[0].label).toBe("✅ Approve UI");
    expect(components[1].label).toBe("❌ Reject UI");
    expect(parseVisualVerdictCustomId(String(components[0].custom_id))).toEqual({ verdict: "approve", artifactId: "visual-1" });
    expect(parseVisualVerdictCustomId(String(components[1].custom_id))).toEqual({ verdict: "reject", artifactId: "visual-1" });
  });
  it("detects screenshot paths embedded in output text", () => {
    const artifact = extractVisualArtifact({ output: "Screenshot saved to /tmp/browser-shot.png" }, "visual-embedded");
    expect(artifact?.source).toBe("/tmp/browser-shot.png");
    expect(artifact?.sourceType).toBe("path");
  });

  it("creates the image review embed and RPC response payload", () => {
    const artifact = {
      id: "visual-2",
      source: "https://example.test/ui.png",
      sourceType: "url" as const,
      name: "ui.png",
      mimeType: "image/png",
    };
    expect(createVisualVerdictEmbed(artifact).toJSON().title).toBe("🖼️ Visual QA Verdict");
    expect(createVisualVerdictResponse("visual-2", "rejected", "Increase contrast")).toEqual({
      type: "visual_verdict",
      artifactId: "visual-2",
      verdict: "rejected",
      feedback: "Increase contrast",
    });
  });
});
