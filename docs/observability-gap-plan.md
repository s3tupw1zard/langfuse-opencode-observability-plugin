# Coding Agent Observability Gap Plan

## Purpose

This document defines the observability fields emitted by the plugin, their
OpenCode sources, and the gaps that must remain unset until OpenCode provides a
reliable source. The plugin does not estimate unavailable values or reinterpret
similarly named fields.

## Field Contract

Generation metadata uses `snake_case`. Existing legacy metadata remains in
place for compatibility, while Langfuse-native model, usage, cost, and session
attributes remain the primary fields for their respective features.

| Field              | Status                  | OpenCode source or derivation                             | Notes                                                                                                                    |
| ------------------ | ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agent`            | Provided/correlated     | `chat.message.agent` or `session.next.step.started.agent` | Assistant `mode` is not treated as the agent.                                                                            |
| `model`            | Provided                | Assistant `modelID`                                       | This is the model identifier reported by OpenCode. It may be a logical router model.                                     |
| `provider`         | Provided                | Assistant `providerID`                                    | Also exported through `gen_ai.system`.                                                                                   |
| `router_alias`     | Unavailable separately  | None                                                      | The plugin does not assume that every `modelID` is a router alias.                                                       |
| `message_id`       | Provided                | Assistant message `id`                                    | Used as the OpenCode generation correlation ID.                                                                          |
| `parent_id`        | Provided                | Assistant `parentID`                                      | Links the generation to its user turn.                                                                                   |
| `session_id`       | Provided                | OpenCode session ID                                       | Also exported through `session.id`.                                                                                      |
| `generation_id`    | Unavailable separately  | None                                                      | OpenCode does not expose an upstream provider generation ID. `message_id` is not duplicated under this name.             |
| `finish_reason`    | Provided                | Assistant `finish`, then final `step-finish.reason`       | The part value is only used when the final message omits it.                                                             |
| `exit_code`        | Unavailable generically | None                                                      | PTY events are not reliably correlated with arbitrary tool calls. Opaque tool metadata is not interpreted heuristically. |
| `tool_calls`       | Derived                 | Number of unique tool `callID` values                     | Generation-level aggregate only.                                                                                         |
| `tool_results`     | Derived                 | Completed plus failed tool calls                          | Pending and running calls are excluded.                                                                                  |
| `tool_success`     | Derived                 | Tool parts with `state.status === "completed"`            | Count, not a boolean.                                                                                                    |
| `tool_errors`      | Derived                 | Tool parts with `state.status === "error"`                | Count, not an error payload.                                                                                             |
| `input_tokens`     | Provided                | Assistant `tokens.input`                                  | Also exported as Langfuse usage.                                                                                         |
| `output_tokens`    | Provided                | Assistant `tokens.output`                                 | Also exported as Langfuse usage.                                                                                         |
| `cached_tokens`    | Provided                | Assistant `tokens.cache.read`                             | Cache-write tokens remain separate as `cache_write_tokens`.                                                              |
| `cost`             | Provided                | Assistant `cost`                                          | Also exported as Langfuse total cost.                                                                                    |
| `latency`          | Unavailable             | None                                                      | True model latency or time to first token is not exposed by the supported hooks.                                         |
| `request_duration` | Derived                 | `time.completed - time.created`                           | Milliseconds. This is not labeled as model latency.                                                                      |
| `iteration_count`  | Derived                 | Deduplicated `step-start` parts                           | Retries are not counted as iterations unless OpenCode emits another step.                                                |
| `aborted`          | Provided/derived        | `MessageAbortedError` on the session or assistant message | User aborts remain observable without being reported as provider failures.                                               |

## Model and Router Semantics

OpenCode 1.15.13 exposes `providerID` and `modelID` to the plugin. It does not
expose both a logical router alias and the concrete backend model selected by a
router. Consequently:

- `model` contains exactly the OpenCode `modelID`.
- `provider` contains exactly the OpenCode `providerID`.
- `router_alias` is omitted unless a future OpenCode contract supplies it as a
  separate field.
- The concrete model selected behind LiteLLM or another router is not reported.

Static routing configuration, model-name parsing, and provider-specific
metadata are not used to guess the selected model.

## Tool Observations

Each tool call has a dedicated Tool Observation. Tool parts are authoritative
for status because `tool.execute.after` does not carry an explicit success
indicator.

Dedicated Tool Observations may contain:

- call, message, and session IDs;
- tool name;
- input and output already captured by the plugin;
- success or error state;
- error details;
- request duration from tool state timestamps.

The parent Generation contains only counts. It does not duplicate tool
arguments, tool output, or error text.

## Debug Logging and Privacy

Debug logging is disabled by default:

```json
{
  "debug": {
    "enabled": false,
    "includePayloads": false
  }
}
```

When enabled, logs contain lifecycle event names, identifiers, model routing
fields, statuses, field presence, counts, and lengths. With
`includePayloads: true`, the plugin adds only bounded, redacted structural
previews. It does not log complete prompts, file contents, tool arguments, tool
results, headers, or credentials.

Debug logging controls plugin diagnostic logs only. It does not change the
telemetry payload sent to Langfuse. In particular, the current plugin still
captures turn and user-message input independently of the generation-level
`captureInput` option. That existing behavior should be reviewed separately if
input collection must become fully opt-in.

## Additional Coding Agent Observability

The following data would improve debugging, performance analysis, and outcome
evaluation if OpenCode exposes stable, privacy-aware sources for it.

### Repository and Change Context

- repository identifier, workspace root hash, branch, and commit;
- clean or dirty worktree state;
- changed-file count and added/deleted line counts;
- whether changes were user-authored or agent-authored.

Raw file content and diffs should remain opt-in.

### Agent Execution Context

- turn index and total session duration;
- primary agent, subagent, delegation parent, and delegation depth;
- command or task category without storing the complete user prompt;
- enabled tools and permission decisions;
- compaction count and context-window utilization.

### Model and Router Context

- logical router alias and actual selected backend model as separate fields;
- fallback model and fallback reason;
- provider request ID;
- queue time, time to first token, provider duration, and total request duration;
- retry delay, rate-limit state, and safe response-header metrics;
- context limits and cache hit ratio.

### Tool and Outcome Context

- tool queue time, execution duration, timeout, cancellation, and exit code;
- build, test, lint, and type-check outcomes;
- commands attempted versus commands completed;
- final task outcome, rollback status, and user feedback;
- normalized error category and recoverability.

These are roadmap gaps, not fields currently inferred by this plugin.

## Validation Strategy

Tests should verify:

- direct fields preserve OpenCode values exactly;
- derived counts are deduplicated and remain isolated by message and session;
- absent values remain absent;
- tool payloads are not copied to Generation metadata;
- aborted messages produce observable, non-error cancellation metadata;
- debug logging is disabled by default and never emits sensitive content;
- out-of-order and duplicate part updates do not inflate aggregates.
