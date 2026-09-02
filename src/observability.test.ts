import { describe, expect, it } from "bun:test";
import {
  createVisualVerdictEmbed,
  createVisualVerdictResponse,
  createVisualVerdictRow,
  extractVisualArtifact,
  formatHudEmbed,
  formatToolExecutionEmbed,
  formatToolOutputPreview,
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
