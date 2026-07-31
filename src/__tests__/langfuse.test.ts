import { describe, it, expect, beforeEach } from "vitest";
import {
  LangfuseClient,
  formatModelName,
  redactSecrets,
  truncateInput,
} from "../langfuse.js";
import type { LangfuseTraceState } from "../langfuse.js";

describe("LangfuseClient", () => {
  let client: LangfuseClient;
  let mockTraceState: LangfuseTraceState;

  beforeEach(() => {
    mockTraceState = {
      tracerName: "opencode-langfuse-plugin",
      tracer: {} as any,
      abortedSessions: new Set(),
      tracedMessageIds: new Set(),
      tracedGenerationIds: new Set(),
      tracedEventIds: new Set(),
      tracedReasoningIds: new Set(),
      pendingReasoningPartsByMessageId: new Map(),
      generationSpansByMessageId: new Map(),
      assistantParts: new Map(),
      turnObservationsByMessageId: new Map(),
      latestTurnObservationsBySession: new Map(),
      turnInputsByMessageId: new Map(),
      subagentInfoByMessageId: new Map(),
      activeToolObservations: new Map(),
      activeGenerationSteps: new Map(),
      generationParentSpans: new Map(),
    };

    client = new LangfuseClient({
      baseUrl: "https://test.langfuse.com",
      traceState: mockTraceState,
      forceFlush: Promise.resolve() as any,
      shutdown: Promise.resolve() as any,
      captureInput: true,
    });
  });

  describe("clearTraceState", () => {
    it("should clear all trace state maps", () => {
      mockTraceState.tracedMessageIds.add("msg-1");
      mockTraceState.tracedGenerationIds.add("gen-1");
      mockTraceState.turnInputsByMessageId.set("msg-1", "input");
      mockTraceState.subagentInfoByMessageId.set("msg-1", { agent: "test" });

      client.clearTraceState();

      // tracedMessageIds and tracedGenerationIds are session-level
      // and intentionally not cleared between turns
      expect(mockTraceState.turnInputsByMessageId.size).toBe(0);
      expect(mockTraceState.subagentInfoByMessageId.size).toBe(0);
      expect(mockTraceState.assistantParts.size).toBe(0);
    });
  });

  describe("captureInput", () => {
    it("should respect captureInput setting", () => {
      expect(client.captureInput).toBe(true);

      const clientNoCapture = new LangfuseClient({
        baseUrl: "https://test.langfuse.com",
        traceState: mockTraceState,
        forceFlush: Promise.resolve() as any,
        shutdown: Promise.resolve() as any,
        captureInput: false,
      });

      expect(clientNoCapture.captureInput).toBe(false);
    });
  });

  describe("formatModelName", () => {
    it("should include provider prefix in model names", () => {
      const modelName = formatModelName("litellm", "coding-plan");
      expect(modelName).toBe("litellm/coding-plan");
    });

    it("should handle arbitrary provider and model IDs", () => {
      expect(formatModelName("anthropic", "claude-3-opus")).toBe(
        "anthropic/claude-3-opus",
      );
    });
  });

  describe("redactSecrets", () => {
    it("should redact sk- API keys", () => {
      const input = "Use API key sk-abc123def456ghi789jkl012mno345pqr678";
      const redacted = redactSecrets(input);

      expect(redacted).not.toContain("sk-abc123def456ghi789jkl012mno345pqr678");
      expect(redacted).toContain("[REDACTED]");
    });

    it("should redact pk- keys", () => {
      const input = "Public key pk-abc123def456ghi789jkl012mno345pqr678";
      const redacted = redactSecrets(input);

      expect(redacted).not.toContain("pk-abc123def456ghi789jkl012mno345pqr678");
      expect(redacted).toContain("[REDACTED]");
    });

    it("should redact Bearer tokens", () => {
      const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9";
      const redacted = redactSecrets(input);

      expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(redacted).toContain("Bearer [REDACTED]");
    });

    it("should redact api_key values", () => {
      const input = 'api_key: "super-secret-token-123"';
      const redacted = redactSecrets(input);

      expect(redacted).not.toContain("super-secret-token-123");
      expect(redacted).toContain('api_key: "[REDACTED]"');
    });

    it("should redact multiple secret patterns in one string", () => {
      const input = `
        API Key: sk-test123456789012345678901234567890
        Token: Bearer eyJhbGciOiJIUzI1NiJ9
        Another: pk-live123456789012345678901234567890
      `;
      const redacted = redactSecrets(input);

      expect(redacted).not.toContain("sk-test123456789012345678901234567890");
      expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(redacted).not.toContain("pk-live123456789012345678901234567890");
    });
  });

  describe("truncateInput", () => {
    it("should truncate inputs exceeding the limit", () => {
      const longInput = "x".repeat(10001);
      const truncated = truncateInput(longInput);

      expect(truncated.length).toBe(10015);
      expect(truncated).toContain("... [truncated]");
    });

    it("should not truncate inputs under limit", () => {
      const shortInput = "x".repeat(1000);
      const truncated = truncateInput(shortInput);

      expect(truncated.length).toBe(1000);
      expect(truncated).not.toContain("[TRUNCATED]");
    });
  });

  describe("trace state new maps", () => {
    it("should support storing turn inputs", () => {
      mockTraceState.turnInputsByMessageId.set(
        "msg-1",
        JSON.stringify({ message: "test input" }),
      );

      expect(mockTraceState.turnInputsByMessageId.get("msg-1")).toBe(
        '{"message":"test input"}',
      );
    });

    it("should support storing subagent inputs", () => {
      mockTraceState.turnInputsByMessageId.set(
        "msg-1:subagent",
        JSON.stringify({ agent: "test-agent", prompt: "do something" }),
      );

      expect(mockTraceState.turnInputsByMessageId.get("msg-1:subagent")).toBe(
        '{"agent":"test-agent","prompt":"do something"}',
      );
    });

    it("should support storing subagent info", () => {
      mockTraceState.subagentInfoByMessageId.set("msg-1", {
        agent: "test-agent",
      });

      expect(mockTraceState.subagentInfoByMessageId.get("msg-1")).toEqual({
        agent: "test-agent",
      });
    });
  });
});
