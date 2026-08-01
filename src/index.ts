import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { Data, Effect, Layer, Schema } from "effect";

import {
  LangfuseClientService,
  createLangfuseClient,
  type ActiveGenerationStep,
  type LangfuseClient,
} from "./langfuse.js";
import { OpencodeClientService } from "./opencode.js";
import {
  createDebugPreview,
  debugLog,
  log,
  sanitizeLogText,
  type DebugConfig,
} from "./utils.js";

// opencode emits these session.next.* events at runtime, but the published
// @opencode-ai/plugin Hooks["event"] type still omits them from its Event union.
type SessionNextEvent =
  | {
      id: string;
      type: "session.next.step.started";
      properties: {
        sessionID: string;
        timestamp: number;
        agent: string;
        model: NonNullable<ActiveGenerationStep["model"]>;
        snapshot?: string;
      };
    }
  | {
      id: string;
      type: "session.next.step.ended";
      properties: { sessionID: string; timestamp: number };
    }
  | {
      id: string;
      type: "session.next.step.failed";
      properties: {
        sessionID: string;
        timestamp: number;
        error: { message: string };
      };
    }
  | {
      id: string;
      type: "session.next.retried";
      properties: {
        sessionID: string;
        timestamp: number;
        attempt: number;
        error: unknown;
      };
    }
  | {
      id: string;
      type: "session.next.reasoning.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        reasoningID: string;
        text: string;
      };
    }
  | {
      id: string;
      type: "session.next.compaction.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        text: string;
        include?: string;
      };
    };

type OpencodeEvent =
  | Parameters<NonNullable<Hooks["event"]>>[0]["event"]
  | SessionNextEvent;

export const LangfuseConfigSchema = Schema.Struct({
  publicKey: Schema.optional(Schema.NonEmptyString),
  secretKey: Schema.optional(Schema.NonEmptyString),
  baseUrl: Schema.optional(Schema.NonEmptyString),
  environment: Schema.optional(Schema.NonEmptyString),
  userId: Schema.optional(Schema.NonEmptyString),
  captureInput: Schema.optional(Schema.Boolean),
  debug: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      includePayloads: Schema.optional(Schema.Boolean),
    }),
  ),
});

type LangfuseFileConfig = typeof LangfuseConfigSchema.Type;
type LangfuseCredentials = LangfuseFileConfig & {
  publicKey: string;
  secretKey: string;
};

class MissingLangfuseCredentials extends Data.TaggedError(
  "MissingLangfuseCredentials",
) {}

const loadLangfuseCredentials = Effect.gen(function* () {
  const hasEnvironmentCredentials = Boolean(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
  );
  const configPath = join(
    homedir(),
    ".config",
    "opencode",
    "opencode-langfuse.json",
  );

  const configContents = yield* Effect.tryPromise({
    try: () => readFile(configPath, "utf8"),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  const fileConfig: LangfuseFileConfig = configContents
    ? yield* Effect.try({
        try: () => JSON.parse(configContents),
        catch: () => new MissingLangfuseCredentials(),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknown(LangfuseConfigSchema)),
        Effect.mapError(() => new MissingLangfuseCredentials()),
        Effect.catchAll(() =>
          hasEnvironmentCredentials
            ? log(
                "warn",
                `[Tracing config ignored] Invalid ${configPath}; using environment credentials`,
              ).pipe(Effect.as({} as LangfuseFileConfig))
            : Effect.fail(new MissingLangfuseCredentials()),
        ),
      )
    : ({} as LangfuseFileConfig);

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? fileConfig.publicKey;
  const secretKey = process.env.LANGFUSE_SECRET_KEY ?? fileConfig.secretKey;

  if (!publicKey || !secretKey) {
    return yield* Effect.fail(new MissingLangfuseCredentials());
  }

  return { ...fileConfig, publicKey, secretKey } satisfies LangfuseCredentials;
});

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

const getEventDebugDetails = (event: OpencodeEvent) => {
  const properties = asRecord(event.properties) ?? {};
  const info = asRecord(properties.info);
  const part = asRecord(properties.part);
  const state = asRecord(part?.state);
  const sessionID = properties.sessionID ?? info?.sessionID ?? part?.sessionID;
  const messageID = properties.messageID ?? info?.id ?? part?.messageID;

  return {
    metadata: {
      event_id: "id" in event ? event.id : undefined,
      session_id: sessionID,
      message_id: messageID,
      parent_id: info?.parentID,
      call_id: part?.callID,
      part_type: part?.type,
      tool: part?.tool,
      status: state?.status,
      provider: info?.providerID,
      model: info?.modelID,
    },
    payloadSummary: {
      property_keys: Object.keys(properties),
      info_keys: info ? Object.keys(info) : undefined,
      part_keys: part ? Object.keys(part) : undefined,
      state_keys: state ? Object.keys(state) : undefined,
      input_keys: Object.keys(asRecord(state?.input) ?? {}),
      text_length:
        typeof part?.text === "string" ? part.text.length : undefined,
      output_length:
        typeof state?.output === "string" ? state.output.length : undefined,
      error_length:
        typeof state?.error === "string" ? state.error.length : undefined,
    },
  };
};

const eventHook = (
  event: OpencodeEvent,
  debug: DebugConfig,
  shutdown?: () => Promise<void>,
) =>
  Effect.gen(function* () {
    const langfuse = yield* LangfuseClientService;
    const debugDetails = getEventDebugDetails(event);
    yield* debugLog(
      debug,
      event.type,
      debugDetails.metadata,
      debugDetails.payloadSummary,
    );

    const finalizeSessionTracing = (sessionID?: string) => {
      langfuse.endActiveToolObservations(sessionID);
      langfuse.endActiveGenerationSteps(sessionID);
      langfuse.endActiveTurnObservations(sessionID);
      langfuse.clearTraceState(sessionID);
    };

    if (event.type === "session.idle") {
      yield* log("info", "Flushing spans");
      finalizeSessionTracing(event.properties.sessionID);

      yield* langfuse.forceFlush;
    }

    if (event.type === "server.instance.disposed") {
      finalizeSessionTracing();

      if (shutdown) {
        yield* Effect.tryPromise({
          try: () => shutdown(),
          catch: (error) => error,
        });
      }
    }

    if (event.type === "session.error" && event.properties.sessionID) {
      langfuse.traceSessionError({
        sessionID: event.properties.sessionID,
        error: event.properties.error,
      });
    }

    if (event.type === "message.part.updated") {
      langfuse.rememberAssistantPart(event.properties.part);
      langfuse.traceReasoningPart(event.properties.part);
      langfuse.traceToolPart(event.properties.part);
    }

    if (event.type === "session.next.step.started") {
      langfuse.startActiveGenerationStep({
        sessionID: event.properties.sessionID,
        agent: event.properties.agent,
        model: event.properties.model,
        started: event.properties.timestamp,
        snapshot: event.properties.snapshot,
      });
    }

    if (event.type === "session.next.step.ended") {
      langfuse.completeActiveGenerationStep(
        event.properties.sessionID,
        event.properties.timestamp,
      );
    }

    if (event.type === "session.next.step.failed") {
      langfuse.traceFailedGenerationStep({
        id: event.id,
        sessionID: event.properties.sessionID,
        completed: event.properties.timestamp,
        error: event.properties.error,
      });
    }

    if (event.type === "session.next.retried") {
      langfuse.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.retry",
        timestamp: event.properties.timestamp,
        output: event.properties.error,
        metadata: {
          attempt: event.properties.attempt,
        },
      });
    }

    if (event.type === "session.next.reasoning.ended") {
      langfuse.traceReasoning({
        reasoningID: event.properties.reasoningID,
        sessionID: event.properties.sessionID,
        timestamp: event.properties.timestamp,
        text: event.properties.text,
        messageID: event.properties.assistantMessageID,
        source: "session.next.reasoning.ended",
      });
    }

    if (event.type === "session.next.compaction.ended") {
      langfuse.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.compaction",
        timestamp: event.properties.timestamp,
        output: { text: event.properties.text },
        metadata: {
          include: event.properties.include,
        },
      });
    }

    if (event.type === "message.updated") {
      const message = event.properties.info;

      if (message.role !== "assistant" || !message.time.completed) {
        return;
      }

      langfuse.traceGeneration({
        sessionID: message.sessionID,
        messageID: message.id,
        parentID: message.parentID,
        modelID: message.modelID,
        providerID: message.providerID,
        mode: message.mode,
        created: message.time.created,
        completed: message.time.completed,
        finish: message.finish,
        cost: message.cost,
        tokens: message.tokens,
        aborted: message.error?.name === "MessageAbortedError",
      });
    }
  });

const formatHookError = (error: unknown) => {
  if (error instanceof Error) {
    return createDebugPreview(error.stack ?? error.message);
  }

  try {
    return createDebugPreview(error);
  } catch {
    return sanitizeLogText(String(error));
  }
};

const createShutdownOnce = (langfuse: LangfuseClient) => {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    if (!shutdownPromise) {
      shutdownPromise = Effect.runPromise(langfuse.shutdown);
    }

    return shutdownPromise;
  };
};

const main = Effect.gen(function* () {
  const opencode = yield* OpencodeClientService;

  const tracing = yield* Effect.gen(function* () {
    const credentials = yield* loadLangfuseCredentials;

    const baseUrl =
      process.env.LANGFUSE_BASEURL ??
      credentials.baseUrl ??
      "https://cloud.langfuse.com";

    const environment =
      process.env.LANGFUSE_ENVIRONMENT ??
      credentials.environment ??
      "development";

    const userId = process.env.LANGFUSE_USER_ID ?? credentials.userId;

    const captureInput =
      process.env.LANGFUSE_CAPTURE_INPUT === undefined
        ? credentials.captureInput
        : process.env.LANGFUSE_CAPTURE_INPUT === "true";

    const debug = {
      enabled: credentials.debug?.enabled ?? false,
      includePayloads: credentials.debug?.includePayloads ?? false,
    } satisfies DebugConfig;

    const client = yield* createLangfuseClient({
      publicKey: credentials.publicKey,
      secretKey: credentials.secretKey,
      baseUrl,
      environment,
      userId,
      captureInput,
    });

    return { client, debug };
  }).pipe(
    Effect.tap(({ client }) =>
      log("info", `OTEL tracing initialized → ${client.baseUrl}`),
    ),
    Effect.catchTag("MissingLangfuseCredentials", () =>
      log("warn", "[Tracing disabled] Missing langfuse credentials"),
    ),
  );

  if (!tracing) {
    return {};
  }

  const { client: langfuse, debug } = tracing;

  const hooksLayer = Layer.merge(
    Layer.succeed(OpencodeClientService, opencode),
    Layer.succeed(LangfuseClientService, langfuse),
  );

  const finalizeTracing = Effect.sync(() => {
    langfuse.endActiveToolObservations();
    langfuse.endActiveGenerationSteps();
    langfuse.endActiveTurnObservations();
    langfuse.clearTraceState();
  });
  const shutdownOnce = createShutdownOnce(langfuse);

  const runHook = (
    hookName: string,
    effect: Effect.Effect<
      unknown,
      unknown,
      OpencodeClientService | LangfuseClientService
    >,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.catchAllDefect((defect) =>
          log(
            "error",
            `Langfuse hook "${hookName}" failed: ${formatHookError(defect)}`,
          ).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.catchAll((error) =>
          log(
            "error",
            `Langfuse hook "${hookName}" failed: ${formatHookError(error)}`,
          ).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.asVoid,
        Effect.provide(hooksLayer),
      ),
    );

  const hooks: Hooks = {
    dispose: () =>
      runHook(
        "dispose",
        finalizeTracing.pipe(
          Effect.zipRight(
            Effect.tryPromise({
              try: () => shutdownOnce(),
              catch: (error) => error,
            }),
          ),
        ),
      ),

    config: (config) =>
      runHook(
        "config",
        Effect.gen(function* () {
          if (!config.experimental?.openTelemetry) {
            yield* log(
              "warn",
              "[Tracing disabled] Please enable `experimental.openTelemetry` in your opencode.jsonc to use the Langfuse plugin",
            );
          }
        }),
      ),

    event: ({ event }) =>
      runHook("event", eventHook(event, debug, shutdownOnce)),

    "chat.message": (input, output) =>
      runHook(
        "chat.message",
        Effect.gen(function* () {
          const agent = input.agent ?? output.message.agent;
          const model = input.model ?? output.message.model;
          const messageID = input.messageID ?? output.message.id;
          yield* debugLog(
            debug,
            "chat.message",
            {
              session_id: input.sessionID,
              message_id: messageID,
              agent,
              provider: model?.providerID,
              model: model?.modelID,
            },
            {
              part_count: output.parts.length,
              part_types: output.parts.map((part) => part.type),
            },
          );
          yield* Effect.try({
            try: () =>
              langfuse.traceUserMessage({
                sessionID: input.sessionID,
                messageID,
                agent,
                model,
                parts: output.parts,
              }),
            catch: (error) => error,
          });
        }),
      ),

    "tool.execute.before": (input, output) =>
      runHook(
        "tool.execute.before",
        Effect.gen(function* () {
          yield* debugLog(
            debug,
            "tool.execute.before",
            {
              session_id: input.sessionID,
              call_id: input.callID,
              tool: input.tool,
            },
            { argument_keys: Object.keys(asRecord(output.args) ?? {}) },
          );
          yield* Effect.try({
            try: () =>
              langfuse.traceToolStart({
                sessionID: input.sessionID,
                callID: input.callID,
                tool: input.tool,
                args: output.args,
              }),
            catch: (error) => error,
          });
        }),
      ),

    "tool.execute.after": (input, output) =>
      runHook(
        "tool.execute.after",
        Effect.gen(function* () {
          yield* debugLog(
            debug,
            "tool.execute.after",
            {
              session_id: input.sessionID,
              call_id: input.callID,
              tool: input.tool,
            },
            {
              title_length: output.title.length,
              output_length: output.output.length,
              metadata_keys: Object.keys(asRecord(output.metadata) ?? {}),
            },
          );
          yield* Effect.try({
            try: () =>
              langfuse.traceToolEnd({
                sessionID: input.sessionID,
                callID: input.callID,
                tool: input.tool,
                args: input.args,
                title: output.title,
                output: output.output,
              }),
            catch: (error) => error,
          });
        }),
      ),
  };

  return hooks;
});

export const LangfusePlugin: Plugin = async ({ client }) => {
  const clientLayer = Layer.succeed(OpencodeClientService, client);

  return Effect.runPromise(main.pipe(Effect.provide(clientLayer)));
};

export default LangfusePlugin;
