# Observability Implementation Audit

**Date:** 2026-08-01
**Version:** 0.1.0-dev.2
**Repository:** @s3tupw1zard/langfuse-opencode-observability-plugin

---

## Overview

This document provides a comprehensive audit of the current OpenCode observability plugin implementation, documenting what data is captured, how it's structured in Langfuse, and what information is currently lost.

---

## 1. OpenCode Events Processed

### 1.1 Core Lifecycle Events

| Event Type | Handler | Purpose |
|------------|---------|---------|
| `session.idle` | `eventHook` | Triggers span flush and finalizes tracing |
| `server.instance.disposed` | `eventHook` | Shuts down Langfuse client and flushes remaining spans |
| `session.error` | `eventHook` | Records session errors with error details |

### 1.2 Message Events

| Event Type | Handler | Purpose |
|------------|---------|---------|
| `message.updated` | `eventHook` | Records completed assistant generations with full metadata |
| `message.part.updated` | `eventHook` | Tracks message parts (text, reasoning, tool calls) |
| `chat.message` | `chat.message` hook | Creates user turn spans and captures user input |

### 1.3 Tool Execution Events

| Event Type | Handler | Purpose |
|------------|---------|---------|
| `tool.execute.before` | `tool.execute.before` hook | Starts tool observation spans |
| `tool.execute.after` | `tool.execute.after` hook | Ends tool spans with results |

### 1.4 Session.Next Events (Extended Telemetry)

| Event Type | Handler | Purpose |
|------------|---------|---------|
| `session.next.step.started` | `startActiveGenerationStep` | Tracks generation step lifecycle with model info |
| `session.next.step.ended` | `endActiveGenerationSteps` | Finalizes generation steps |
| `session.next.step.failed` | `traceFailedGenerationStep` | Records failed generation steps |
| `session.next.retried` | `traceEvent` | Captures retry attempts with attempt number |
| `session.next.reasoning.ended` | `traceReasoning` | Records reasoning/chain-of-thought output |
| `session.next.compaction.ended` | `traceEvent` | Captures context compaction summaries |

---

## 2. Trace Structure in Langfuse

### 2.1 Root Span: `opencode.turn`

**Created by:** `traceUserMessage`
**Type:** Span (app root)
**Lifecycle:** One per user message/session turn

**Attributes:**
```typescript
{
  "langfuse.observation.type": "span",
  "langfuse.internal.is_app_root": true,
  "session.id": string,
  "langfuse.observation.input": string, // JSON: user message parts
  "langfuse.observation.metadata": {
    messageID: string,
    agent: string,
    providerID: string,
    modelID: string,
    fullModelName: string,
    subagent?: boolean,
    subagent_name?: string
  }
}
```

**Child Observations:**
- User message event
- Generation spans
- Tool observation spans

### 2.2 User Message Event: `opencode.message.user`

**Created by:** `traceUserMessage`
**Type:** Event
**Parent:** `opencode.turn`

**Attributes:**
```typescript
{
  "langfuse.observation.type": "event",
  "session.id": string,
  "langfuse.observation.input": string,
  "langfuse.observation.metadata": { ... }
}
```

### 2.3 Generation Span: `opencode.generation`

**Created by:** `traceGeneration` or `startActiveGenerationStep`
**Type:** Generation
**Parent:** `opencode.turn` or generation parent span

**Attributes:**
```typescript
{
  "langfuse.observation.type": "generation",
  "session.id": string,
  "langfuse.observation.model.name": string, // "providerID/modelID"
  "gen_ai.system": string,
  "gen_ai.request.model": string,
  "langfuse.observation.output": string, // JSON: assistant text
  "langfuse.observation.usage_details": {
    input: number,
    output: number,
    reasoning: number,
    cache_read: number,
    cache_write: number,
    total: number
  },
  "langfuse.observation.cost_details": {
    total: number
  },
  "langfuse.observation.metadata": {
    messageID: string,
    parentID: string,
    agent: string,
    providerID: string,
    mode: string,
    stage: string,
    finish: string,
    variant: string,
    snapshot: string,
    subagent?: boolean,
    subagent_name?: string
  }
}
```

**Note:** When `captureInput` is enabled, also includes:
```typescript
{
  "langfuse.observation.input": string // JSON: user message (redacted)
}
```

### 2.4 Failed Generation: `opencode.generation.failed`

**Created by:** `traceFailedGenerationStep`
**Type:** Generation
**Status:** ERROR

**Attributes:**
```typescript
{
  "langfuse.observation.type": "generation",
  "session.id": string,
  "langfuse.observation.output": {
    error: { message: string, name: string }
  }
}
```

### 2.5 Tool Observation: `<tool_name>`

**Created by:** `traceToolStart` / `traceToolEnd`
**Type:** Tool
**Parent:** Generation span or turn span

**Attributes:**
```typescript
{
  "langfuse.observation.type": "tool",
  "session.id": string,
  "langfuse.observation.input": string, // JSON: tool arguments
  "langfuse.observation.output": {
    title: string,
    output: string
  },
  "langfuse.observation.metadata": {
    callID: string,
    tool: string
  }
}
```

### 2.6 Reasoning Event: `opencode.generation.reasoning`

**Created by:** `traceReasoning`
**Type:** Event
**Parent:** Generation span

**Attributes:**
```typescript
{
  "langfuse.observation.type": "event",
  "session.id": string,
  "langfuse.observation.output": {
    text: string
  },
  "langfuse.observation.metadata": {
    reasoningID: string,
    messageID: string,
    source: string // "message.part.updated" | "session.next.reasoning.ended"
  }
}
```

### 2.7 Retry Event: `opencode.generation.retry`

**Created by:** `traceEvent`
**Type:** Event
**Parent:** Turn span

**Attributes:**
```typescript
{
  "langfuse.observation.type": "event",
  "session.id": string,
  "langfuse.observation.output": unknown, // error details
  "langfuse.observation.metadata": {
    attempt: number
  }
}
```

### 2.8 Compaction Event: `opencode.generation.compaction`

**Created by:** `traceEvent`
**Type:** Event
**Parent:** Turn span

**Attributes:**
```typescript
{
  "langfuse.observation.type": "event",
  "session.id": string,
  "langfuse.observation.output": {
    text: string
  },
  "langfuse.observation.metadata": {
    include: string
  }
}
```

---

## 3. ID Correlation Strategy

### 3.1 Session-Level Tracking

| ID Type | Storage | Purpose |
|---------|---------|---------|
| `sessionID` | Multiple maps | Groups all observations within a session |
| `messageID` | `turnObservationsByMessageId`, `generationSpansByMessageId` | Links user messages to assistant responses |
| `parentID` | Generation metadata | Tracks parent message for nested conversations |

### 3.2 Generation Tracking

| ID Type | Storage | Purpose |
|---------|---------|---------|
| Generation step | `activeGenerationSteps` (Map by sessionID) | Tracks active LLM generation lifecycle |
| Generation span | `generationParentSpans` (Map by sessionID) | Parent span for tool calls |
| Message-to-span | `generationSpansByMessageId` | Links message ID to its generation span |

### 3.3 Tool Call Tracking

| ID Type | Storage | Purpose |
|---------|---------|---------|
| `callID` | `activeToolObservations` (Map) | Correlates tool start/end events |

### 3.4 Reasoning Tracking

| ID Type | Storage | Purpose |
|---------|---------|---------|
| `reasoningID` + `sessionID` | `tracedReasoningIds` (Set) | Prevents duplicate reasoning traces |
| `reasoningID` | Stored in metadata | Links reasoning to specific generation |

### 3.5 Event Deduplication

| ID Type | Storage | Purpose |
|---------|---------|---------|
| Message ID | `tracedMessageIds` (Set) | Prevents duplicate user message traces |
| Generation ID | `tracedGenerationIds` (Set) | Prevents duplicate generation spans |
| Event ID | `tracedEventIds` (Set) | Prevents duplicate event traces |

---

## 4. Metadata Captured

### 4.1 Global Metadata (All Spans)

| Attribute | Description | Source |
|-----------|-------------|--------|
| `langfuse.user.id` | Optional user identifier | Config/env var `LANGFUSE_USER_ID` |
| `langfuse.plugin.version` | Plugin version | `version.ts` |
| `session.id` | OpenCode session ID | Event properties |

### 4.2 Turn-Level Metadata

- `messageID`: User message identifier
- `agent`: Agent type (e.g., "build", "plan")
- `providerID`: LLM provider (e.g., "anthropic", "openai")
- `modelID`: Model identifier
- `fullModelName`: Combined "provider/model" string
- `subagent`: Boolean flag for subagent invocations
- `subagent_name`: Name of subagent if applicable

### 4.3 Generation-Level Metadata

- All turn-level metadata plus:
- `parentID`: Parent message ID
- `mode`: Generation mode (e.g., "chat", "compaction")
- `stage`: Alias for mode
- `finish`: Finish reason (e.g., "stop", "length")
- `variant`: Model variant if available
- `snapshot`: Model snapshot/version

### 4.4 Token Usage Details

```typescript
{
  input: number,
  output: number,
  reasoning: number,
  cache_read: number,
  cache_write: number,
  total: number
}
```

### 4.5 Cost Details

```typescript
{
  total: number // Total cost in USD
}
```

### 4.6 Tool Call Metadata

- `callID`: Unique identifier for the tool invocation
- `tool`: Tool name
- Input: Tool arguments (JSON)
- Output: Tool result (JSON with title and output)

### 4.7 Error Information

```typescript
{
  name: string, // Error type (e.g., "MessageAbortedError")
  message: string // Error message
}
```

---

## 5. Data Security & Privacy

### 5.1 Input Redaction

The `redactSecrets` function removes:
- OpenAI-style API keys: `sk-[a-zA-Z0-9]{20,}`
- Public keys: `pk-[a-zA-Z0-9]{20,}`
- Bearer tokens: `Bearer [token]`
- API key patterns: `api_key: "[value]"`

**Limitations:**
- Pattern-based only; may miss custom secret formats
- Does not redact PII (names, emails, etc.)
- Does not redact file paths or code content

### 5.2 Input Truncation

- Maximum input length: 10,000 characters
- Truncated inputs marked with `... [truncated]`
- Prevents excessive payload sizes

### 5.3 Capture Input Control

- Opt-in via `captureInput` flag (default: `false`)
- Can be set via config or environment variable
- Applies to user messages and generation inputs

---

## 6. Information Currently Lost

### 6.1 User & Context Information

- ❌ **User identity**: Only optional `userId` from config
- ❌ **Workspace path**: No workspace context
- ❌ **Git information**: No branch, commit, or diff tracking
- ❌ **Environment details**: Only a string label, no OS/runtime info
- ❌ **Feature flags**: No visibility into enabled features
- ❌ **Permissions**: No permission/authorization context

### 6.2 Message Content Details

- ❌ **Streaming partial outputs**: Only final text captured
- ❌ **Message metadata**: No creation timestamps in final trace
- ❌ **Message role context**: Limited to "user" and "assistant"
- ❌ **Conversation history**: Only current turn captured
- ❌ **System prompts**: No visibility into system instructions

### 6.3 Tool Execution Details

- ❌ **Intermediate tool states**: Only start/end captured
- ❌ **Tool execution duration**: Not explicitly tracked
- ❌ **Tool error details**: Error status not set on tool spans
- ❌ **Tool output truncation**: Full output captured (may be large)
- ⚠️ **File operations**: File paths captured but not file contents
- ⚠️ **Search results**: Captured but may include large payloads

### 6.4 LLM Provider Details

- ❌ **Request parameters**: No temperature, max_tokens, etc.
- ❌ **Response headers**: No rate limit or provider metadata
- ❌ **Model capabilities**: No context window or feature info
- ❌ **Retry logic details**: Only attempt number, no backoff info
- ❌ **Provider-specific metadata**: No OpenAI/Anthropic/etc. specifics

### 6.5 Execution Flow

- ❌ **Parallel execution**: No tracking of concurrent tool calls
- ❌ **Dependency graph**: No explicit parent-child beyond span hierarchy
- ❌ **Execution order**: No sequence numbers or ordering metadata
- ❌ **Timeouts**: No timeout information
- ❌ **Circuit breakers**: No visibility into rate limiting

### 6.6 Reasoning & Chain-of-Thought

- ⚠️ **Partial reasoning**: Only completed reasoning captured
- ❌ **Reasoning segments**: No breakdown of reasoning phases
- ❌ **Thinking tokens**: Not separately tracked from output tokens

### 6.7 Session Lifecycle

- ❌ **Session duration**: No explicit session span
- ❌ **Session boundaries**: Session start/end not clearly marked
- ❌ **Session metadata**: No session creation time, title, etc.

### 6.8 Error Context

- ⚠️ **Stack traces**: Only error message and name captured
- ❌ **Error codes**: No provider error codes
- ❌ **Retry decisions**: No visibility into retry logic
- ❌ **Fallback behavior**: No tracking of fallback models

---

## 7. Existing Tests

### 7.1 Test Coverage

**File:** `src/__tests__/langfuse.test.ts`

| Test Suite | Coverage | Quality |
|------------|----------|---------|
| `clearTraceState` | Verifies state maps are cleared | ✅ Good |
| `captureInput` | Tests capture input flag | ⚠️ Basic |
| `formatModelName` | Tests model name formatting | ✅ Good |
| `redactSecrets` | Tests secret redaction patterns | ✅ Good |
| `truncateInput` | Tests input truncation | ✅ Good |
| `trace state new maps` | Tests new map structures | ⚠️ Basic |

### 7.2 Test Gaps

- ❌ **No integration tests**: No end-to-end event flow testing
- ❌ **No event handler tests**: No tests for `eventHook` logic
- ❌ **No span structure tests**: No validation of span attributes
- ❌ **No OTEL tests**: No tests for span processor behavior
- ❌ **No mock Langfuse server**: Tests don't verify actual Langfuse output
- ❌ **No error handling tests**: Limited error scenario coverage
- ❌ **No concurrent execution tests**: No race condition testing
- ❌ **No performance tests**: No latency or memory usage testing

### 7.3 Test Quality Assessment

**Strengths:**
- Good coverage of utility functions
- Tests core data transformations
- Validates security features (redaction)

**Weaknesses:**
- Mock-heavy without real integration
- No behavioral tests for complex logic
- No regression tests for bugs
- No snapshot testing for span structures

---

## 8. Implementation Quality Assessment

### 8.1 Strengths

✅ **Comprehensive event coverage**: Handles all major OpenCode events  
✅ **Proper span hierarchy**: Clear parent-child relationships  
✅ **Deduplication**: Prevents duplicate traces via ID tracking  
✅ **Security**: Secret redaction and input truncation  
✅ **Opt-in privacy**: Input capture is opt-in  
✅ **Extensibility**: Clean architecture with Effect-based design  
✅ **Error handling**: Graceful error handling with Effect  
✅ **Type safety**: Full TypeScript implementation  
✅ **Active state management**: Proper cleanup on session end  

### 8.2 Weaknesses

⚠️ **Complex state management**: Large trace state object, hard to maintain  
⚠️ **Limited test coverage**: Only utility functions tested  
⚠️ **No observability of observability**: No metrics on plugin performance  
⚠️ **Hard-coded limits**: Fixed truncation length, no config  
⚠️ **Inconsistent naming**: Mix of `opencode.*` and tool names  
⚠️ **No version migration**: No strategy for schema changes  

### 8.3 Code Quality

**Architecture:**
- Effect-based dependency injection ✅
- Clean separation of concerns ✅
- Proper resource cleanup ✅
- Good use of OpenTelemetry APIs ✅

**Maintainability:**
- Type-safe ✅
- Modular design ✅
- Clear naming (mostly) ✅
- Some complex functions (e.g., `traceGeneration`) ⚠️

---

## 9. Recommendations

### 9.1 High Priority

1. **Add integration tests**: Test actual span generation with mock Langfuse
2. **Document span schema**: Create formal schema documentation
3. **Add plugin metrics**: Track plugin performance and errors
4. **Improve error context**: Capture stack traces and error codes
5. **Add session span**: Create explicit session-level span

### 9.2 Medium Priority

1. **Capture system prompts**: Track system instructions sent to LLMs
2. **Track request parameters**: Capture temperature, max_tokens, etc.
3. **Add tool timing**: Explicit duration tracking for tools
4. **Improve redaction**: Add PII detection beyond API keys
5. **Add workspace context**: Track project/git information

### 9.3 Low Priority

1. **Add streaming support**: Capture partial outputs
2. **Track dependencies**: Build dependency graph of tool calls
3. **Add custom attributes**: Allow user-defined metadata
4. **Performance optimization**: Reduce memory usage for large sessions
5. **Schema versioning**: Add version to span attributes

---

## 10. Conclusion

The plugin provides solid foundational observability for OpenCode sessions, capturing the core flow of user messages, LLM generations, and tool calls. The implementation is well-architected with proper state management and security features.

**Key gaps:**
- Limited test coverage
- No explicit session tracking
- Missing context (git, workspace, system prompts)
- No plugin performance metrics

**Next steps:**
1. Add comprehensive integration tests
2. Document the span schema formally
3. Add session-level tracking
4. Capture additional context (system prompts, parameters)
5. Add plugin performance monitoring

---

**Document Version:** 1.0  
**Last Updated:** 2026-03-18  
**Author:** Observability Audit (Automated)
