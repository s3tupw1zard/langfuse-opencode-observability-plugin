# Langfuse OpenCode Plugin

OpenCode plugin that sends OpenCode session telemetry to Langfuse. It traces user turns, assistant generations, tool calls, retries, reasoning output, compaction output, and failed generation steps.

## Upstream

Originally forked from [Langfuse OpenCode Observability Plugin](https://github.com/langfuse/opencode-observability-plugin/tree/a3b8507389475f96fa5396baf0cf889bc229cdc8#readme) v0.2.0.

## Quick Start

Enable the plugin in your `opencode.json` or `opencode.jsonc`:

```json
{
  "experimental": {
    "openTelemetry": true
  },
  "plugin": ["@s3tupw1zard/langfuse-opencode-observability-plugin@dev"]
}
```

Restart OpenCode after changing the config.

## Langfuse Credentials

Create `~/.config/opencode/opencode-langfuse.json` with your Langfuse credentials.

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "environment": "development",
  "userId": "your-user-id",
  "debug": {
    "enabled": false,
    "includePayloads": false
  }
}
```

Only `publicKey` and `secretKey` are required. If `baseUrl` is not set, the plugin uses `https://cloud.langfuse.com`. If `environment` is not set, it uses `development`.

You can also set credentials with environment variables:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASEURL="https://cloud.langfuse.com"
export LANGFUSE_ENVIRONMENT="development"
export LANGFUSE_USER_ID="your-user-id"
```

Environment variables override matching credential and optional fields from the config file. The file is still read for options such as `debug` when credentials come from the environment.

## Debug Logging

Set `debug.enabled` to `true` to log OpenCode event types, correlation IDs, model fields, statuses, and payload shape information. Debug logging is disabled by default.

`debug.includePayloads` adds only short, redacted structural previews. Complete prompts, file contents, tool arguments, tool output, headers, and credentials are never written to debug logs. Restart OpenCode after changing this configuration.

See [Coding Agent Observability Gap Plan](./docs/observability-gap-plan.md) for the emitted field contract and explicitly unavailable OpenCode data.

## License

[MIT](./LICENSE)
