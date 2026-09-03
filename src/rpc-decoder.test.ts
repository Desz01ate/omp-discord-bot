import { describe, expect, it } from "bun:test";
import { isRpcChunkFrame, RpcChunkFrame, RpcFrameDecoder } from "./rpc-decoder";

describe("RpcFrameDecoder", () => {
  it("passes through standard non-chunk frames immediately", () => {
    const decoder = new RpcFrameDecoder();
    const event = { type: "agent_start" };

    const result = decoder.push(event);
    expect(result).toBe(event);
  });

  it("passes through null, undefined or non-object gracefully", () => {
    const decoder = new RpcFrameDecoder();
    expect(decoder.push(null)).toBeUndefined();
    expect(decoder.push(undefined)).toBeUndefined();
    expect(decoder.push("string")).toBeUndefined();
    expect(decoder.push(123)).toBeUndefined();
  });

  it("identifies valid and invalid RpcChunkFrame values", () => {
    expect(isRpcChunkFrame(null)).toBe(false);
    expect(isRpcChunkFrame({})).toBe(false);
    expect(isRpcChunkFrame({ type: "agent_end" })).toBe(false);

    const validChunk: RpcChunkFrame = {
      type: "rpc_chunk",
      chunkId: "c1",
      index: 0,
      count: 2,
      byteLength: 100,
      data: Buffer.from("test").toString("base64"),
    };
    expect(isRpcChunkFrame(validChunk)).toBe(true);

    expect(isRpcChunkFrame({ ...validChunk, count: 1.5 })).toBe(false);
    expect(isRpcChunkFrame({ ...validChunk, data: 123 })).toBe(false);
  });

  it("reassembles a 2-chunk logical frame into the original JSON object", () => {
    const decoder = new RpcFrameDecoder();
    const originalObject = {
      type: "agent_end",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "World" },
      ],
      usage: { input: 100, output: 50 },
    };
    const jsonBytes = Buffer.from(JSON.stringify(originalObject), "utf-8");
    const half = Math.floor(jsonBytes.length / 2);

    const chunk0: RpcChunkFrame = {
      type: "rpc_chunk",
      chunkId: "rpc-test-1",
      index: 0,
      count: 2,
      byteLength: jsonBytes.length,
      data: jsonBytes.subarray(0, half).toString("base64"),
    };

    const chunk1: RpcChunkFrame = {
      type: "rpc_chunk",
      chunkId: "rpc-test-1",
      index: 1,
      count: 2,
      byteLength: jsonBytes.length,
      data: jsonBytes.subarray(half).toString("base64"),
    };

    const res0 = decoder.push(chunk0);
    expect(res0).toBeUndefined();

    const res1 = decoder.push(chunk1);
    expect(res1).toBeDefined();
    expect(res1).toEqual(originalObject);
  });

  it("reassembles large multi-chunk payloads (>1MB) without loss", () => {
    const decoder = new RpcFrameDecoder();
    const largeContent = "A".repeat(1.5 * 1024 * 1024);
    const largeObject = {
      type: "agent_end",
      content: largeContent,
      items: Array.from({ length: 500 }, (_, i) => ({ id: i, value: `item_${ i }` })),
    };
    const jsonBytes = Buffer.from(JSON.stringify(largeObject), "utf-8");
    const chunkSize = 256 * 1024;
    const count = Math.ceil(jsonBytes.length / chunkSize);
    const chunkId = "large-chunk-id";

    let finalResult: Record<string, unknown> | undefined;

    for (let i = 0; i < count; i++) {
      const slice = jsonBytes.subarray(i * chunkSize, Math.min(jsonBytes.length, (i + 1) * chunkSize));
      const chunk: RpcChunkFrame = {
        type: "rpc_chunk",
        chunkId,
        index: i,
        count,
        byteLength: jsonBytes.length,
        data: slice.toString("base64"),
      };
      const intermediate = decoder.push(chunk);
      if (i < count - 1) {
        expect(intermediate).toBeUndefined();
      } else {
        finalResult = intermediate;
      }
    }

    expect(finalResult).toBeDefined();
    expect(finalResult?.type).toBe("agent_end");
    expect(finalResult?.content).toBe(largeContent);
    expect((finalResult?.items as unknown[]).length).toBe(500);
  });

  it("handles out-of-order chunks by dropping and resetting", () => {
    const decoder = new RpcFrameDecoder();
    const chunk: RpcChunkFrame = {
      type: "rpc_chunk",
      chunkId: "bad-seq",
      index: 1, // Invalid: must start at 0
      count: 3,
      byteLength: 50,
      data: Buffer.from("hello").toString("base64"),
    };

    expect(decoder.push(chunk)).toBeUndefined();
  });

  it("resets pending buffer cleanly if an unchunked frame interrupts a chunk sequence", () => {
    const decoder = new RpcFrameDecoder();
    const chunk0: RpcChunkFrame = {
      type: "rpc_chunk",
      chunkId: "interrupted",
      index: 0,
      count: 2,
      byteLength: 20,
      data: Buffer.from("abc").toString("base64"),
    };

    expect(decoder.push(chunk0)).toBeUndefined();

    // Interrupting normal frame
    const interrupt = { type: "message_update", delta: "test" };
    const passed = decoder.push(interrupt);
    expect(passed).toEqual(interrupt);

    // Following chunk 1 should now be rejected because sequence was reset
    const chunk1: RpcChunkFrame = {
      type: "rpc_chunk",
      chunkId: "interrupted",
      index: 1,
      count: 2,
      byteLength: 20,
      data: Buffer.from("def").toString("base64"),
    };
    expect(decoder.push(chunk1)).toBeUndefined();
  });

  it("resets buffer when reset() is explicitly called", () => {
    const decoder = new RpcFrameDecoder();
    const chunk0: RpcChunkFrame = {
      type: "rpc_chunk",
      chunkId: "reset-test",
      index: 0,
      count: 2,
      byteLength: 20,
      data: Buffer.from("abc").toString("base64"),
    };

    expect(decoder.push(chunk0)).toBeUndefined();
    decoder.reset();

    const chunk1: RpcChunkFrame = {
      type: "rpc_chunk",
      chunkId: "reset-test",
      index: 1,
      count: 2,
      byteLength: 20,
      data: Buffer.from("def").toString("base64"),
    };
    expect(decoder.push(chunk1)).toBeUndefined();
  });

  it("reassembles frames encoded by OMP RpcFrameEncoder (protocol v2)", () => {
    const decoder = new RpcFrameDecoder();
    const hugeTurn = {
      type: "agent_end",
      messages: Array.from({ length: 200 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Detailed message content for step ${ i }: ` + "x".repeat(7000),
      })),
    };

    const json = JSON.stringify(hugeTurn);
    const jsonBytes = Buffer.from(json, "utf-8");
    expect(jsonBytes.length).toBeGreaterThan(1024 * 1024);

    // Encode chunks following OMP v2 chunk specifications (256KB chunks)
    const chunkSize = 256 * 1024;
    const totalChunks = Math.ceil(jsonBytes.length / chunkSize);
    const chunkId = "rpc-sim-v2";
    const chunks: RpcChunkFrame[] = [];

    for (let index = 0; index < totalChunks; index++) {
      const slice = jsonBytes.subarray(index * chunkSize, Math.min(jsonBytes.length, (index + 1) * chunkSize));
      chunks.push({
        type: "rpc_chunk",
        chunkId,
        index,
        count: totalChunks,
        byteLength: jsonBytes.length,
        data: slice.toString("base64"),
      });
    }

    let reassembled: Record<string, unknown> | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const result = decoder.push(chunks[i]);
      if (i === chunks.length - 1) {
        reassembled = result;
      } else {
        expect(result).toBeUndefined();
      }
    }

    expect(reassembled).toBeDefined();
    expect(reassembled?.type).toBe("agent_end");
    expect((reassembled?.messages as unknown[]).length).toBe(200);
  });
});
