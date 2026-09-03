/**
 * OMP RPC Protocol v2 Chunk Frame.
 * Emitted by OMP when a logical frame (e.g. agent_end) exceeds MAX_RPC_FRAME_BYTES (1MB).
 */
export interface RpcChunkFrame {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string; // Base64 encoded payload slice
}

interface PendingRpcChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

/**
 * Validates whether an unknown parsed JSON object is an RpcChunkFrame.
 */
export function isRpcChunkFrame(value: unknown): value is RpcChunkFrame {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "rpc_chunk" &&
    typeof candidate.chunkId === "string" &&
    typeof candidate.data === "string" &&
    Number.isSafeInteger(candidate.index) &&
    Number.isSafeInteger(candidate.count) &&
    Number.isSafeInteger(candidate.byteLength)
  );
}

/**
 * Reassembles OMP RPC Protocol v2 chunk frames into complete logical frames.
 * Non-chunk frames pass through untouched.
 */
export class RpcFrameDecoder {
  private pending?: PendingRpcChunks;

  /**
   * Process an incoming parsed JSON line.
   * - Returns the complete logical frame if this was a non-chunk frame or the final chunk.
   * - Returns undefined if this was an intermediate chunk still waiting for siblings.
   */
  public push(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    if (!isRpcChunkFrame(value)) {
      if (this.pending) {
        console.warn(
          `[RpcDecoder] Interrupted chunk sequence for chunkId "${ this.pending.chunkId }": received unchunked frame of type "${ (value as Record<string, unknown>).type }". Resetting chunk buffer.`,
        );
        this.pending = undefined;
      }
      return value as Record<string, unknown>;
    }

    const { chunkId, index, count, byteLength, data } = value;

    if (index < 0 || count < 2 || index >= count || byteLength <= 0) {
      console.warn(`[RpcDecoder] Malformed rpc_chunk metadata (index: ${ index }, count: ${ count }, byteLength: ${ byteLength }).`);
      this.pending = undefined;
      return undefined;
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(data, "base64");
    } catch (err) {
      console.warn(`[RpcDecoder] Failed to decode base64 chunk data for chunkId "${ chunkId }" index ${ index }:`, err);
      this.pending = undefined;
      return undefined;
    }

    if (!this.pending) {
      if (index !== 0) {
        console.warn(`[RpcDecoder] Chunk sequence for chunkId "${ chunkId }" must start at index 0, got ${ index }. Dropping chunk.`);
        return undefined;
      }
      this.pending = {
        chunkId,
        count,
        byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
    }

    const pending = this.pending;

    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      console.warn(
        `[RpcDecoder] Chunk sequence mismatch for chunkId "${ chunkId }": expected index ${ pending.nextIndex }, got ${ index }. Resetting buffer.`,
      );
      this.pending = undefined;
      return undefined;
    }

    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex++;

    if (pending.nextIndex < pending.count) {
      return undefined;
    }

    // All chunks received; reassemble and parse JSON
    this.pending = undefined;

    if (pending.receivedBytes !== pending.byteLength) {
      console.warn(
        `[RpcDecoder] Length mismatch for chunkId "${ chunkId }": expected ${ pending.byteLength } bytes, reassembled ${ pending.receivedBytes } bytes.`,
      );
      return undefined;
    }

    try {
      const fullBuffer = Buffer.concat(pending.chunks);
      const decodedJson = new TextDecoder("utf-8", { fatal: true }).decode(fullBuffer);
      const frame: unknown = JSON.parse(decodedJson);
      if (!frame || typeof frame !== "object") {
        console.warn(`[RpcDecoder] Reassembled chunk payload for chunkId "${ chunkId }" did not parse to an object.`);
        return undefined;
      }
      return frame as Record<string, unknown>;
    } catch (err) {
      console.error(`[RpcDecoder] Failed to reassemble and parse chunkId "${ chunkId }":`, err);
      return undefined;
    }
  }

  /**
   * Reset any pending chunk buffers.
   */
  public reset(): void {
    this.pending = undefined;
  }
}
