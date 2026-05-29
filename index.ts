/**
 * Model Proxy Extension
 *
 * Per-model HTTP proxy configuration. When switching to a model that has a
 * proxy configured, all HTTP requests (API calls) are routed through that
 * proxy via HTTP CONNECT tunneling. Switching to any other model restores
 * direct connection.
 *
 * Uses undici's ProxyAgent + setGlobalDispatcher under the hood, which
 * intercepts all fetch() calls issued by pi's providers.
 *
 * Config file: ~/.pi/agent/model-proxy.json
 *
 * Example:
 * ```json
 * {
 *   "models": {
 *     "openai-codex/gpt-5.5": "http://127.0.0.1:7890",
 *     "anthropic/claude-sonnet-4-5": "http://127.0.0.1:7890"
 *   }
 * }
 * ```
 *
 * Proxy URL supports optional auth via userinfo:
 *   "http://user:pass@127.0.0.1:7890"
 *
 * Usage:
 * - Auto-applies on model switch (via /model or Ctrl+P)
 * - `/proxy` — show status
 * - `/proxy set openai-codex/gpt-5.5 http://127.0.0.1:7890`
 * - `/proxy remove openai-codex/gpt-5.5`
 * - `/proxy list` — list all configured proxies
 * - Status bar indicator when proxy is active: "🔀 proxy:openai-codex"
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ProxyAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
} from "undici";
import type { Dispatcher } from "undici";

// ── Types ───────────────────────────────────────────────────────────────────

interface ProxyConfig {
  /** Map of "provider/modelId" → proxy URL (e.g. "http://127.0.0.1:7890") */
  models: Record<string, string>;
}

// ── State ───────────────────────────────────────────────────────────────────

/** The undici dispatcher to use when no proxy is active (direct connect). */
let directDispatcher: Dispatcher | null = null;
/** Currently active ProxyAgent (null = direct connect). */
let activeProxyAgent: ProxyAgent | null = null;
/** Currently proxied provider (null = no active proxy). */
let activeProxyProvider: string | null = null;
/** Currently active proxy URL. */
let activeProxyUrl: string | null = null;
/** Loaded proxy configuration. */
let proxyConfig: ProxyConfig = { models: {} };

// ── Helpers ─────────────────────────────────────────────────────────────────

function configPath(): string {
  return join(getAgentDir(), "model-proxy.json");
}

function loadConfig(): void {
  const path = configPath();
  if (existsSync(path)) {
    try {
      proxyConfig = JSON.parse(readFileSync(path, "utf-8"));
      if (!proxyConfig.models || typeof proxyConfig.models !== "object") {
        proxyConfig = { models: {} };
      }
    } catch (err) {
      console.error(`[model-proxy] Failed to load config: ${err}`);
      proxyConfig = { models: {} };
    }
  } else {
    proxyConfig = { models: {} };
  }
}

function saveConfig(): void {
  const path = configPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(proxyConfig, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error(`[model-proxy] Failed to save config: ${err}`);
  }
}

function getProxyUrl(provider: string, modelId: string): string | undefined {
  return proxyConfig.models[`${provider}/${modelId}`];
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

// ── Proxy Management ────────────────────────────────────────────────────────

/**
 * Route all HTTP traffic through the proxy. Uses undici's ProxyAgent which
 * tunnels HTTPS via HTTP CONNECT and forwards HTTP directly.
 */
function applyProxy(pi: ExtensionAPI, provider: string, proxyUrl: string): boolean {
  if (activeProxyProvider === provider && activeProxyUrl === proxyUrl) {
    return false; // Already applied
  }

  // Lazily capture the direct dispatcher on first proxy application
  if (!directDispatcher) {
    directDispatcher = getGlobalDispatcher();
  }

  // Close previous ProxyAgent if any (avoid resource leak)
  if (activeProxyAgent) {
    try { activeProxyAgent.close(); } catch {}
  }

  // Create new ProxyAgent and set as global dispatcher
  // ProxyAgent uses HTTP CONNECT for HTTPS and plain proxy for HTTP
  const proxyAgent = new ProxyAgent({ uri: proxyUrl });
  setGlobalDispatcher(proxyAgent);

  activeProxyAgent = proxyAgent;
  activeProxyProvider = provider;
  activeProxyUrl = proxyUrl;
  return true;
}

/**
 * Restore direct connection (no proxy).
 */
function removeProxy(_pi: ExtensionAPI): boolean {
  if (!activeProxyAgent) return false;

  // Restore the original dispatcher
  if (directDispatcher) {
    setGlobalDispatcher(directDispatcher);
  }

  // Clean up the ProxyAgent
  try { activeProxyAgent.close(); } catch {}
  activeProxyAgent = null;
  activeProxyProvider = null;
  activeProxyUrl = null;
  return true;
}

/**
 * Handle model selection: apply or remove proxy based on config.
 */
function handleModelChange(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): void {
  const proxyUrl = getProxyUrl(provider, modelId);

  if (proxyUrl) {
    // This model needs a proxy
    if (activeProxyProvider === provider) {
      if (activeProxyUrl !== proxyUrl) {
        applyProxy(pi, provider, proxyUrl);
        ctx.ui.notify(`Proxy updated: ${provider} → ${proxyUrl}`, "info");
      }
    } else {
      removeProxy(pi);
      applyProxy(pi, provider, proxyUrl);
      ctx.ui.notify(`Proxy ON: ${provider} → ${proxyUrl}`, "info");
    }
    updateStatus(ctx);
  } else {
    // No proxy needed — restore direct connection
    if (activeProxyAgent) {
      const was = activeProxyProvider;
      removeProxy(pi);
      ctx.ui.notify(`Proxy OFF (${was} restored to direct)`, "info");
      updateStatus(ctx);
    }
  }
}

// ── UI ──────────────────────────────────────────────────────────────────────

function updateStatus(ctx: ExtensionContext): void {
  if (activeProxyProvider && activeProxyUrl) {
    ctx.ui.setStatus("proxy", ctx.ui.theme.fg("warning", `🔀 proxy:${activeProxyProvider}`));
  } else {
    ctx.ui.setStatus("proxy", undefined);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("proxy", {
    description: "Configure per-model HTTP proxy settings",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);

      if (parts.length === 0 || parts[0] === "" || parts[0] === "status") {
        showStatus(ctx);
        return;
      }

      const subcommand = parts[0].toLowerCase();

      switch (subcommand) {
        case "list":
          showProxyList(ctx);
          return;

        case "set": {
          if (parts.length < 3) {
            ctx.ui.notify("Usage: /proxy set <provider/modelId> <proxyUrl>", "error");
            return;
          }
          const key = parts[1];
          const url = parts[2];
          setProxy(pi, ctx, key, url);
          return;
        }

        case "remove":
        case "rm":
        case "delete": {
          if (parts.length < 2) {
            ctx.ui.notify("Usage: /proxy remove <provider/modelId>", "error");
            return;
          }
          removeProxyConfig(pi, ctx, parts[1]);
          return;
        }

        default:
          ctx.ui.notify(
            `Unknown subcommand: ${subcommand}. Try: status, list, set, remove`,
            "error",
          );
      }
    },
  });
}

function showStatus(ctx: ExtensionContext): void {
  const currentModel = ctx.model;
  const currentKey = currentModel
    ? modelKey(currentModel.provider, currentModel.id)
    : "none";
  const currentProxy = currentModel
    ? getProxyUrl(currentModel.provider, currentModel.id)
    : undefined;

  const lines: string[] = [
    `Current model: ${currentKey}`,
    currentProxy
      ? `Configured proxy: ${currentProxy}`
      : "No proxy configured for this model",
    activeProxyAgent
      ? `Traffic routing: PROXY ${activeProxyProvider} → ${activeProxyUrl}`
      : "Traffic routing: DIRECT (no proxy active)",
    "",
    `Config file: ${configPath()}`,
    `Entries: ${Object.keys(proxyConfig.models).length}`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

function showProxyList(ctx: ExtensionContext): void {
  const entries = Object.entries(proxyConfig.models);

  if (entries.length === 0) {
    ctx.ui.notify("No proxy entries configured.", "info");
    return;
  }

  const maxLen = Math.max(...entries.map(([k]) => k.length));
  const lines = entries.map(
    ([key, url]) => `${key.padEnd(maxLen + 2)} → ${url}`,
  );

  ctx.ui.notify(`Model proxy config:\n${lines.join("\n")}`, "info");
}

function setProxy(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  key: string,
  url: string,
): void {
  if (!key.includes("/")) {
    ctx.ui.notify(
      `Invalid model key "${key}". Expected: provider/modelId`,
      "error",
    );
    return;
  }

  // Validate URL (accept http, https, socks5, etc.)
  try {
    new URL(url);
  } catch {
    ctx.ui.notify(`Invalid URL: ${url}`, "error");
    return;
  }

  const [provider, modelId] = key.split("/", 2);
  loadConfig();
  proxyConfig.models[key] = url;
  saveConfig();

  ctx.ui.notify(`Proxy set: ${key} → ${url}`, "info");

  // If currently on this model, apply immediately
  if (ctx.model && modelKey(ctx.model.provider, ctx.model.id) === key) {
    handleModelChange(pi, ctx, provider, modelId);
  }
}

function removeProxyConfig(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  key: string,
): void {
  loadConfig();

  if (!(key in proxyConfig.models)) {
    ctx.ui.notify(`No proxy configured for: ${key}`, "warning");
    return;
  }

  delete proxyConfig.models[key];
  saveConfig();

  ctx.ui.notify(`Proxy removed: ${key}`, "info");

  // If currently on this model, restore direct connection
  if (ctx.model && modelKey(ctx.model.provider, ctx.model.id) === key) {
    if (removeProxy(pi)) {
      updateStatus(ctx);
      ctx.ui.notify("Proxy disabled, traffic now direct", "info");
    }
  }
}

// ── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Cache the direct dispatcher at startup
  directDispatcher = getGlobalDispatcher();

  // Load user config
  loadConfig();

  // Register slash command
  registerCommands(pi);

  // On session start, sync proxy state with current model
  pi.on("session_start", async (_event, ctx) => {
    loadConfig();

    if (ctx.model) {
      const proxyUrl = getProxyUrl(ctx.model.provider, ctx.model.id);
      if (proxyUrl) {
        applyProxy(pi, ctx.model.provider, proxyUrl);
      }
    }
    updateStatus(ctx);
  });

  // On model change, apply/remove proxy
  pi.on("model_select", async (event, ctx) => {
    // Skip restore — proxy already applied in session_start
    if (event.source === "restore") return;

    handleModelChange(pi, ctx, event.model.provider, event.model.id);
  });

  // Clean up ProxyAgent on shutdown
  pi.on("session_shutdown", async () => {
    if (activeProxyAgent) {
      // Restore direct dispatcher so shutdown requests don't use proxy
      if (directDispatcher) {
        setGlobalDispatcher(directDispatcher);
      }
      try { activeProxyAgent.close(); } catch {}
      activeProxyAgent = null;
    }
  });
}
