import { describe, expect, it } from "bun:test";
import {
  type OmpModelMeta,
  getCanonicalModelSelector,
  getModelSuggestions,
  isKnownModel,
  resolveModelSelector,
} from "./models";

const mockModels: OmpModelMeta[] = [
  {
    id: "antigravity/gemini-3.7-flash-high",
    name: "antigravity/gemini-3.7-flash-high",
    provider: "litellm",
    contextWindow: 1048576,
  },
  {
    id: "antigravity/gemini-3.8-flash-high",
    name: "antigravity/gemini-3.8-flash-high",
    provider: "litellm",
    contextWindow: 1048576,
  },
  {
    id: "Junie-router",
    name: "Junie-router",
    provider: "litellm",
    contextWindow: 1048576,
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "litellm",
    contextWindow: 1050000,
  },
  {
    id: "openai/gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "litellm",
    contextWindow: 1050000,
  },
  {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    provider: "anthropic",
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    provider: "anthropic",
    contextWindow: 200000,
  },
];

describe("models - getCanonicalModelSelector", () => {
  it("prefixes provider when id does not start with provider prefix", () => {
    expect(
      getCanonicalModelSelector({ id: "openai/gpt-5.6-luna", provider: "litellm" }),
    ).toBe("litellm/openai/gpt-5.6-luna");

    expect(
      getCanonicalModelSelector({ id: "Junie-router", provider: "litellm" }),
    ).toBe("litellm/Junie-router");

    expect(
      getCanonicalModelSelector({ id: "claude-3-7-sonnet", provider: "anthropic" }),
    ).toBe("anthropic/claude-3-7-sonnet");
  });

  it("does not duplicate provider prefix when id already starts with it", () => {
    expect(
      getCanonicalModelSelector({ id: "anthropic/claude-opus-4", provider: "anthropic" }),
    ).toBe("anthropic/claude-opus-4");

    expect(
      getCanonicalModelSelector({ id: "litellm/custom-model", provider: "litellm" }),
    ).toBe("litellm/custom-model");
  });

  it("returns id as-is when provider is missing", () => {
    expect(getCanonicalModelSelector({ id: "local-model" })).toBe("local-model");
  });
});

describe("models - resolveModelSelector", () => {
  it("resolves already qualified selector", () => {
    expect(resolveModelSelector("litellm/openai/gpt-5.6-luna", mockModels)).toBe(
      "litellm/openai/gpt-5.6-luna",
    );
  });

  it("resolves bare model id on litellm to qualified provider selector", () => {
    expect(resolveModelSelector("openai/gpt-5.6-luna", mockModels)).toBe(
      "litellm/openai/gpt-5.6-luna",
    );
    expect(resolveModelSelector("Junie-router", mockModels)).toBe("litellm/Junie-router");
    expect(resolveModelSelector("antigravity/gemini-3.8-flash-high", mockModels)).toBe(
      "litellm/antigravity/gemini-3.8-flash-high",
    );
  });

  it("resolves model by display name", () => {
    expect(resolveModelSelector("GPT-5.6 Luna", mockModels)).toBe(
      "litellm/openai/gpt-5.6-luna",
    );
    expect(resolveModelSelector("Claude 3.7 Sonnet", mockModels)).toBe(
      "anthropic/claude-3-7-sonnet",
    );
  });

  it("resolves model by id suffix", () => {
    expect(resolveModelSelector("gpt-5.6-luna", mockModels)).toBe(
      "litellm/openai/gpt-5.6-luna",
    );
    expect(resolveModelSelector("gemini-3.8-flash-high", mockModels)).toBe(
      "litellm/antigravity/gemini-3.8-flash-high",
    );
  });

  it("resolves unambiguous partial match", () => {
    expect(resolveModelSelector("luna", mockModels)).toBe("litellm/openai/gpt-5.6-luna");
    expect(resolveModelSelector("Junie", mockModels)).toBe("litellm/Junie-router");
  });

  it("falls back to trimmed input when no match is found", () => {
    expect(resolveModelSelector("custom-future-model", mockModels)).toBe(
      "custom-future-model",
    );
  });

  it("falls back to input when models list is empty", () => {
    expect(resolveModelSelector("openai/gpt-5.6-luna", [])).toBe(
      "openai/gpt-5.6-luna",
    );
    expect(resolveModelSelector("gpt-5.2")).toBe("gpt-5.2");
  });
});

describe("models - isKnownModel", () => {
  it("returns true for exact id, name, suffix, or qualified selector", () => {
    expect(isKnownModel("openai/gpt-5.6-luna", mockModels)).toBe(true);
    expect(isKnownModel("litellm/openai/gpt-5.6-luna", mockModels)).toBe(true);
    expect(isKnownModel("GPT-5.6 Luna", mockModels)).toBe(true);
    expect(isKnownModel("gpt-5.6-luna", mockModels)).toBe(true);
    expect(isKnownModel("Junie-router", mockModels)).toBe(true);
  });

  it("returns false for unknown model when models list is populated", () => {
    expect(isKnownModel("completely-unknown-model", mockModels)).toBe(false);
    expect(isKnownModel("", mockModels)).toBe(false);
  });

  it("returns true when models list is empty or undefined", () => {
    expect(isKnownModel("any-model", [])).toBe(true);
    expect(isKnownModel("any-model")).toBe(true);
  });
});

describe("models - getModelSuggestions", () => {
  it("returns suggestions with canonical qualified selector values", () => {
    const suggestions = getModelSuggestions("", mockModels);
    expect(suggestions.length).toBe(mockModels.length);

    const luna = suggestions.find((s) => s.name.includes("GPT-5.6 Luna"));
    expect(luna).toBeDefined();
    expect(luna?.value).toBe("litellm/openai/gpt-5.6-luna");

    const sonnet = suggestions.find((s) => s.name.includes("Claude 3.7 Sonnet"));
    expect(sonnet).toBeDefined();
    expect(sonnet?.value).toBe("anthropic/claude-3-7-sonnet");
  });

  it("filters suggestions by query", () => {
    const lunaResults = getModelSuggestions("luna", mockModels);
    expect(lunaResults.length).toBe(1);
    expect(lunaResults[0].value).toBe("litellm/openai/gpt-5.6-luna");

    const litellmResults = getModelSuggestions("litellm", mockModels);
    expect(litellmResults.length).toBe(5);
  });
});

describe("models - OMP live integration", () => {
  it("launches OMP with resolved model and successfully initializes on litellm", async () => {
    const resolved = resolveModelSelector("openai/gpt-5.6-luna", mockModels);
    expect(resolved).toBe("litellm/openai/gpt-5.6-luna");

    const proc = Bun.spawn(["omp", "--mode", "rpc", `--model=${ resolved }`], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(JSON.stringify({ id: "init", type: "negotiate_protocol", protocolVersion: 2 }) + "\n");
    proc.stdin.write(JSON.stringify({ id: "state_check", type: "get_state" }) + "\n");
    proc.stdin.flush();

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let receivedModel: { id?: string; provider?: string } | undefined;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          const event = JSON.parse(line);
          if (event.id === "state_check" && event.data?.model) {
            receivedModel = event.data.model;
            break;
          }
        }
        if (receivedModel) {
          break;
        }
      }
    } finally {
      try {
        proc.kill();
      } catch {}
    }

    expect(receivedModel).toBeDefined();
    expect(receivedModel?.provider).toBe("litellm");
    expect(receivedModel?.id).toBe("openai/gpt-5.6-luna");
  });
});
