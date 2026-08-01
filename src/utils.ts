import { Effect } from "effect";

import { OpencodeClientService } from "./opencode.js";

const MAX_DEBUG_PREVIEW_LENGTH = 500;

export type DebugConfig = {
  enabled: boolean;
  includePayloads: boolean;
};

export const sanitizeLogText = (text: string) => {
  const tokenRedacted = text
    .replace(/(sk-[a-zA-Z0-9-]{12,})/g, "[REDACTED]")
    .replace(/(pk-[a-zA-Z0-9-]{12,})/g, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
  const sensitiveAssignment =
    /["']?(?:api[_-]?key|secret(?:[_-]?key)?|password|authorization)["']?\s*[:=]\s*/i.exec(
      tokenRedacted,
    );

  if (!sensitiveAssignment || sensitiveAssignment.index === undefined) {
    return tokenRedacted;
  }

  const valueStart = sensitiveAssignment.index + sensitiveAssignment[0].length;
  return `${tokenRedacted.slice(0, valueStart)}[REDACTED]`;
};

export const createDebugPreview = (value: unknown) => {
  let serialized: string;

  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  const sanitized = sanitizeLogText(serialized);
  return sanitized.length > MAX_DEBUG_PREVIEW_LENGTH
    ? `${sanitized.slice(0, MAX_DEBUG_PREVIEW_LENGTH)}... [truncated]`
    : sanitized;
};

export const log = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const opencode = yield* OpencodeClientService;

    yield* Effect.sync(() =>
      opencode.app.log({
        body: { service: "langfuse", level, message, extra },
      }),
    );
  });

export const debugLog = (
  config: DebugConfig,
  eventType: string,
  metadata: Record<string, unknown>,
  payloadSummary?: unknown,
) => {
  if (!config.enabled) {
    return Effect.void;
  }

  return log("debug", `OpenCode event: ${eventType}`, {
    event_type: eventType,
    ...metadata,
    ...(config.includePayloads && payloadSummary !== undefined
      ? { payload_preview: createDebugPreview(payloadSummary) }
      : {}),
  });
};
