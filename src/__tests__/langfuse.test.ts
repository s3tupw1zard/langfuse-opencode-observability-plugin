import { Effect, Schema } from "effect";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { LangfuseConfigSchema } from "../index.js";
import {
  LangfuseClient,
  formatModelName,
  redactSecrets,
  truncateInput,
} from "../langfuse.js";
import type { LangfuseTraceState } from "../langfuse.js";
import { createDebugPreview, debugLog, sanitizeLogText } from "../utils.js";

const createMockSpan = () => ({
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
});

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
      tracedEventIdsBySession: new Map(),
      tracedReasoningIds: new Set(),
      pendingReasoningPartsByMessageId: new Map(),
      generationSpansByMessageId: new Map(),
      assistantParts: new Map(),
      turnObservationsByMessageId: new Map(),
      latestTurnObservationsBySession: new Map(),
      turnInputsByMessageId: new Map(),
      subagentInfoByMessageId: new Map(),
      agentByMessageId: new Map(),
      activeToolObservations: new Map(),
      finalizedToolCallIds: new Map(),
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
    it("clears only the requested session state", () => {
      mockTraceState.assistantParts.set(
        "assistant-a",
        new Map([
          [
            "part-a",
            {
              id: "part-a",
              sessionID: "session-a",
              messageID: "assistant-a",
              type: "text",
              text: "a",
            } as any,
          ],
        ]),
      );
      mockTraceState.assistantParts.set(
        "assistant-b",
        new Map([
          [
            "part-b",
            {
              id: "part-b",
              sessionID: "session-b",
              messageID: "assistant-b",
              type: "text",
              text: "b",
            } as any,
          ],
        ]),
      );
      mockTraceState.tracedEventIds.add("event-a");
      mockTraceState.tracedEventIds.add("event-b");
      mockTraceState.tracedEventIdsBySession.set(
        "session-a",
        new Set(["event-a"]),
      );
      mockTraceState.tracedEventIdsBySession.set(
        "session-b",
        new Set(["event-b"]),
      );
      mockTraceState.tracedReasoningIds.add("session-a:reasoning");
      mockTraceState.tracedReasoningIds.add("session-b:reasoning");

      client.clearTraceState("session-a");

      expect(mockTraceState.assistantParts.has("assistant-a")).toBe(false);
      expect(mockTraceState.assistantParts.has("assistant-b")).toBe(true);
      expect(mockTraceState.tracedEventIds.has("event-a")).toBe(false);
      expect(mockTraceState.tracedEventIds.has("event-b")).toBe(true);
      expect(mockTraceState.tracedReasoningIds.has("session-a:reasoning")).toBe(
        false,
      );
      expect(mockTraceState.tracedReasoningIds.has("session-b:reasoning")).toBe(
        true,
      );
    });

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

  describe("generation observability", () => {
    it("maps provided and derived fields without duplicating tool payloads", () => {
      const span = createMockSpan();
      mockTraceState.activeGenerationSteps.set("session-1", {
        span: span as any,
        agent: "build",
        model: { id: "coding-plan", providerID: "litellm" },
      });
      mockTraceState.abortedSessions.add("session-1");
      mockTraceState.assistantParts.set(
        "assistant-1",
        new Map(
          [
            {
              id: "step-1",
              sessionID: "session-1",
              messageID: "assistant-1",
              type: "step-start",
            },
            {
              id: "step-2",
              sessionID: "session-1",
              messageID: "assistant-1",
              type: "step-start",
            },
            {
              id: "finish-1",
              sessionID: "session-1",
              messageID: "assistant-1",
              type: "step-finish",
              reason: "stop",
              cost: 0.1,
              tokens: {
                input: 1,
                output: 2,
                reasoning: 3,
                cache: { read: 4, write: 5 },
              },
            },
            {
              id: "tool-1",
              sessionID: "session-1",
              messageID: "assistant-1",
              type: "tool",
              callID: "call-1",
              tool: "read",
              state: {
                status: "completed",
                input: { path: "secret-file" },
                output: "sensitive output",
                title: "Read",
                metadata: {},
                time: { start: 10, end: 20 },
              },
            },
            {
              id: "tool-2",
              sessionID: "session-1",
              messageID: "assistant-1",
              type: "tool",
              callID: "call-2",
              tool: "bash",
              state: {
                status: "error",
                input: { command: "false" },
                error: "failed",
                time: { start: 20, end: 30 },
              },
            },
          ].map((part) => [part.id, part as any]),
        ),
      );

      client.traceGeneration({
        sessionID: "session-1",
        messageID: "assistant-1",
        parentID: "user-1",
        modelID: "coding-plan",
        providerID: "litellm",
        mode: "build",
        created: 1_000,
        completed: 1_450,
        cost: 0.25,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 25,
          cache: { read: 40, write: 10 },
        },
      });

      const metadataCall = span.setAttribute.mock.calls.find(
        ([name]) => name === "langfuse.observation.metadata",
      );
      const metadata = JSON.parse(metadataCall?.[1] as string);

      expect(metadata).toMatchObject({
        agent: "build",
        model: "coding-plan",
        provider: "litellm",
        message_id: "assistant-1",
        parent_id: "user-1",
        session_id: "session-1",
        finish_reason: "stop",
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 40,
        cache_write_tokens: 10,
        cost: 0.25,
        request_duration: 450,
        iteration_count: 2,
        aborted: true,
        tool_calls: 2,
        tool_results: 2,
        tool_success: 1,
        tool_errors: 1,
      });
      expect(metadata).not.toHaveProperty("router_alias");
      expect(metadata).not.toHaveProperty("generation_id");
      expect(metadata).not.toHaveProperty("exit_code");
      expect(metadata).not.toHaveProperty("latency");
      expect(JSON.stringify(metadata)).not.toContain("sensitive output");
      expect(JSON.stringify(metadata)).not.toContain("secret-file");
    });
  });

  describe("tool observations", () => {
    it("marks tool errors from authoritative tool part state", () => {
      const span = createMockSpan();
      mockTraceState.tracer = {
        startSpan: vi.fn(() => span),
      } as any;

      client.traceToolPart({
        id: "tool-1",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "false" },
          error: "exit 1",
          time: { start: 100, end: 150 },
        },
      } as any);

      expect(span.setStatus).toHaveBeenCalledWith({
        code: 2,
        message: "exit 1",
      });
      expect(span.end).toHaveBeenCalledWith(new Date(150));
      expect(
        Array.from(mockTraceState.finalizedToolCallIds.values()),
      ).toContain("session-1");
    });

    it("keeps identical call IDs isolated between sessions", () => {
      const firstSpan = createMockSpan();
      const secondSpan = createMockSpan();
      mockTraceState.tracer = {
        startSpan: vi
          .fn()
          .mockReturnValueOnce(firstSpan)
          .mockReturnValueOnce(secondSpan),
      } as any;

      client.traceToolStart({
        sessionID: "session-a",
        callID: "shared-call",
        tool: "read",
        args: {},
      });
      client.traceToolStart({
        sessionID: "session-b",
        callID: "shared-call",
        tool: "read",
        args: {},
      });

      expect(mockTraceState.activeToolObservations.size).toBe(2);

      client.traceToolPart({
        id: "tool-a",
        sessionID: "session-a",
        messageID: "assistant-a",
        type: "tool",
        callID: "shared-call",
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output: "a",
          title: "Read",
          metadata: {},
          time: { start: 10, end: 20 },
        },
      } as any);

      expect(firstSpan.end).toHaveBeenCalledWith(new Date(20));
      expect(secondSpan.end).not.toHaveBeenCalled();
      expect(mockTraceState.activeToolObservations.size).toBe(1);
    });

    it("waits for terminal tool state after an abort", () => {
      const span = createMockSpan();
      mockTraceState.tracer = {
        startSpan: vi.fn(() => span),
      } as any;
      client.traceToolStart({
        sessionID: "session-1",
        callID: "call-1",
        tool: "bash",
        args: {},
      });

      client.traceSessionError({
        sessionID: "session-1",
        error: {
          name: "MessageAbortedError",
          data: { message: "aborted" },
        },
      });

      expect(span.end).not.toHaveBeenCalled();

      client.traceToolPart({
        id: "tool-1",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "error",
          input: {},
          error: "aborted",
          time: { start: 100, end: 125 },
        },
      } as any);

      expect(span.end).toHaveBeenCalledWith(new Date(125));
      expect(span.setStatus).toHaveBeenCalledWith({
        code: 2,
        message: "aborted",
      });
    });
  });
});

describe("debug configuration", () => {
  it("does not require a logger when debug logging is disabled", async () => {
    await expect(
      Effect.runPromise(
        debugLog(
          { enabled: false, includePayloads: false },
          "message.updated",
          { session_id: "session-1" },
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("accepts an omitted or explicit debug configuration", () => {
    expect(
      Schema.decodeUnknownSync(LangfuseConfigSchema)({
        publicKey: "public",
        secretKey: "secret",
      }).debug,
    ).toBeUndefined();

    expect(
      Schema.decodeUnknownSync(LangfuseConfigSchema)({
        debug: { enabled: true, includePayloads: true },
      }).debug,
    ).toEqual({ enabled: true, includePayloads: true });
  });

  it("rejects invalid debug values", () => {
    expect(() =>
      Schema.decodeUnknownSync(LangfuseConfigSchema)({
        debug: { enabled: "yes" },
      }),
    ).toThrow();
  });

  it("redacts and truncates debug previews", () => {
    const credentialPreview = createDebugPreview({
      authorization: "Bearer top-secret-token",
    });
    const longPreview = createDebugPreview({
      value: "x".repeat(1_000),
    });

    expect(credentialPreview).toContain("[REDACTED]");
    expect(credentialPreview).not.toContain("top-secret-token");
    expect(longPreview).toContain("[truncated]");
    expect(sanitizeLogText("api_key=private-value")).not.toContain(
      "private-value",
    );
    const credentials = sanitizeLogText(
      '{"password":"alpha beta","authorization":"Basic abc123"}',
    );
    expect(credentials).toContain('"password":[REDACTED]');
    expect(credentials).not.toContain("alpha beta");
    expect(credentials).not.toContain("Basic abc123");
    expect(sanitizeLogText('{"password":"alpha\\"beta"}')).not.toContain(
      "beta",
    );
    expect(sanitizeLogText('password: "alpha\nbeta"')).not.toContain("beta");
  });
});
