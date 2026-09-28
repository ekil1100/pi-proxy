/**
 * Provider Proxy Extension
 *
 * Per-provider HTTP proxy configuration. Models from the same provider share
 * one proxy. Switching to a provider without a configured proxy restores
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
 *   "providers": {
 *     "openai-codex": "http://127.0.0.1:7890",
 *     "anthropic": "http://127.0.0.1:7890"
 *   }
 * }
 * ```
 *
 * Proxy URL supports optional auth via userinfo:
 *   "http://user:pass@127.0.0.1:7890"
 *
 * Usage:
 * - Auto-applies on model switch (via /model or Ctrl+P)
 * - `/proxy` — toggle proxy routing for the current session
 * - `/proxy on|off` — enable or disable proxy routing
 * - `/proxy default on|off` — persist the default for future sessions
 * - `/proxy status` — show status
 * - `/proxy set openai-codex http://127.0.0.1:7890`
 * - `/proxy remove openai-codex`
 * - `/proxy list` — list all configured proxies
 * - Status bar indicator when proxy is active: "proxy"
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
  /** Whether proxy routing is enabled on session startup (defaults to true). */
  defaultEnabled?: boolean;
  /** Map of provider ID → proxy URL (e.g. "http://127.0.0.1:7890"). */
  providers: Record<string, string>;
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
let proxyConfig: ProxyConfig = { providers: {} };
/** Runtime switch, independent from the persisted startup default. */
let enabled = true;

// ── Helpers ─────────────────────────────────────────────────────────────────

function configPath(): string {
  return join(getAgentDir(), "model-proxy.json");
}

function isProviderId(provider: string): boolean {
  return provider.length > 0 && !/[\s/]/.test(provider);
}

function loadConfig(): void {
  proxyConfig = { providers: {} };
  const path = configPath();
  if (!existsSync(path)) return;

  try {
    const config = JSON.parse(readFileSync(path, "utf-8"));
    if (!config?.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) {
      throw new Error('Expected a "providers" object. Configure provider keys manually.');
    }
    for (const [provider, url] of Object.entries(config.providers)) {
      if (!isProviderId(provider) || typeof url !== "string" || url.length === 0) {
        throw new Error("Expected provider IDs mapped to proxy URL strings.");
      }
    }
    if (config.defaultEnabled !== undefined && typeof config.defaultEnabled !== "boolean") {
      throw new Error('Expected "defaultEnabled" to be a boolean.');
    }
    proxyConfig = {
      providers: config.providers,
      ...(config.defaultEnabled !== undefined ? { defaultEnabled: config.defaultEnabled } : {}),
    };
  } catch (err) {
    console.error(`[model-proxy] Failed to load config: ${err}`);
  }
}

function saveConfig(): boolean {
  const path = configPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(proxyConfig, null, 2) + "\n", "utf-8");
    return true;
  } catch (err) {
    console.error(`[model-proxy] Failed to save config: ${err}`);
    return false;
  }
}

function getProxyUrl(provider: string): string | undefined {
  return Object.hasOwn(proxyConfig.providers, provider)
    ? proxyConfig.providers[provider]
    : undefined;
}

// ── Proxy Management ────────────────────────────────────────────────────────

/**
 * Route all HTTP traffic through the proxy. Uses undici's ProxyAgent which
 * tunnels HTTPS via HTTP CONNECT and forwards HTTP directly.
 */
function applyProxy(provider: string, proxyUrl: string): boolean {
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
function removeProxy(): boolean {
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
 * Apply the selected provider's proxy, reusing it across model changes.
 */
function handleProviderChange(ctx: ExtensionContext, provider: string): void {
  const proxyUrl = enabled ? getProxyUrl(provider) : undefined;

  if (proxyUrl) {
    if (activeProxyProvider === provider) {
      if (activeProxyUrl !== proxyUrl) {
        applyProxy(provider, proxyUrl);
        ctx.ui.notify(`Proxy updated: ${provider} → ${proxyUrl}`, "info");
      }
    } else {
      removeProxy();
      applyProxy(provider, proxyUrl);
      ctx.ui.notify(`Proxy ON: ${provider} → ${proxyUrl}`, "info");
    }
    updateStatus(ctx);
  } else {
    // No proxy needed — restore direct connection
    if (activeProxyAgent) {
      const was = activeProxyProvider;
      removeProxy();
      ctx.ui.notify(`Proxy OFF (${was} restored to direct)`, "info");
      updateStatus(ctx);
    }
  }
}

// ── UI ──────────────────────────────────────────────────────────────────────

function updateStatus(ctx: ExtensionContext): void {
  if (activeProxyProvider && activeProxyUrl) {
    ctx.ui.setStatus("proxy", ctx.ui.theme.fg("warning", "proxy"));
  } else {
    ctx.ui.setStatus("proxy", undefined);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("proxy", {
    description: "Configure per-provider HTTP proxy settings",
    getArgumentCompletions: (prefix) => {
      const choices = ["on", "off", "default on", "default off", "status", "list", "set", "remove"];
      const matches = choices.filter((value) => value.startsWith(prefix));
      return matches.length > 0
        ? matches.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);

      if (parts[0] === "") {
        setEnabled(ctx, !enabled);
        return;
      }

      const subcommand = parts[0].toLowerCase();

      switch (subcommand) {
        case "on":
        case "off":
          if (parts.length !== 1) {
            ctx.ui.notify("Usage: /proxy on|off", "error");
            return;
          }
          setEnabled(ctx, subcommand === "on");
          return;

        case "default": {
          if (parts.length !== 2 || !["on", "off"].includes(parts[1])) {
            ctx.ui.notify("Usage: /proxy default on|off", "error");
            return;
          }
          loadConfig();
          const previous = proxyConfig.defaultEnabled;
          proxyConfig.defaultEnabled = parts[1] === "on";
          if (!saveConfig()) {
            proxyConfig.defaultEnabled = previous;
            ctx.ui.notify("Failed to save proxy default.", "error");
            return;
          }
          ctx.ui.notify(`Proxy default: ${parts[1].toUpperCase()} (applies on next session startup)`, "info");
          return;
        }

        case "status":
          showStatus(ctx);
          return;

        case "list":
          showProxyList(ctx);
          return;

        case "set": {
          if (parts.length < 3) {
            ctx.ui.notify("Usage: /proxy set <provider> <proxyUrl>", "error");
            return;
          }
          const provider = parts[1];
          const url = parts[2];
          setProxy(ctx, provider, url);
          return;
        }

        case "remove":
        case "rm":
        case "delete": {
          if (parts.length < 2) {
            ctx.ui.notify("Usage: /proxy remove <provider>", "error");
            return;
          }
          removeProxyConfig(ctx, parts[1]);
          return;
        }

        default:
          ctx.ui.notify(
            `Unknown subcommand: ${subcommand}. Try: on, off, default on|off, status, list, set, remove`,
            "error",
          );
      }
    },
  });
}

function setEnabled(ctx: ExtensionContext, value: boolean): void {
  enabled = value;
  if (ctx.model) {
    handleProviderChange(ctx, ctx.model.provider);
  } else {
    removeProxy();
  }
  updateStatus(ctx);
  showStatus(ctx);
}

function showStatus(ctx: ExtensionContext): void {
  const currentProvider = ctx.model?.provider;
  const currentProxy = currentProvider ? getProxyUrl(currentProvider) : undefined;

  const lines: string[] = [
    `Proxy plugin: ${enabled ? "ON" : "OFF"}`,
    `Startup default: ${(proxyConfig.defaultEnabled ?? true) ? "ON" : "OFF"}`,
    `Current provider: ${currentProvider ?? "none"}`,
    currentProxy
      ? `Configured proxy: ${currentProxy}`
      : "No proxy configured for this provider",
    activeProxyAgent
      ? `Traffic routing: PROXY ${activeProxyProvider} → ${activeProxyUrl}`
      : "Traffic routing: DIRECT (no proxy active)",
    "",
    `Config file: ${configPath()}`,
    `Providers: ${Object.keys(proxyConfig.providers).length}`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

function showProxyList(ctx: ExtensionContext): void {
  const entries = Object.entries(proxyConfig.providers);

  if (entries.length === 0) {
    ctx.ui.notify("No proxy entries configured.", "info");
    return;
  }

  const maxLen = Math.max(...entries.map(([k]) => k.length));
  const lines = entries.map(
    ([key, url]) => `${key.padEnd(maxLen + 2)} → ${url}`,
  );

  ctx.ui.notify(`Provider proxy config:\n${lines.join("\n")}`, "info");
}

function setProxy(ctx: ExtensionContext, provider: string, url: string): void {
  if (!isProviderId(provider)) {
    ctx.ui.notify(`Invalid provider "${provider}". Expected: provider ID without a model suffix.`, "error");
    return;
  }

  // Validate the URL before persisting it.
  try {
    new URL(url);
  } catch {
    ctx.ui.notify(`Invalid URL: ${url}`, "error");
    return;
  }

  loadConfig();
  proxyConfig.providers = { ...proxyConfig.providers, [provider]: url };
  saveConfig();

  ctx.ui.notify(`Proxy set: ${provider} → ${url}`, "info");

  // Apply immediately to any active model from this provider.
  if (ctx.model?.provider === provider) {
    handleProviderChange(ctx, provider);
  }
}

function removeProxyConfig(ctx: ExtensionContext, provider: string): void {
  if (!isProviderId(provider)) {
    ctx.ui.notify(`Invalid provider "${provider}". Expected: provider ID without a model suffix.`, "error");
    return;
  }

  loadConfig();

  if (!Object.hasOwn(proxyConfig.providers, provider)) {
    ctx.ui.notify(`No proxy configured for: ${provider}`, "warning");
    return;
  }

  delete proxyConfig.providers[provider];
  saveConfig();

  ctx.ui.notify(`Proxy removed: ${provider}`, "info");

  // Restore direct traffic for any active model from this provider.
  if (ctx.model?.provider === provider) {
    if (removeProxy()) {
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
    enabled = proxyConfig.defaultEnabled ?? true;

    const provider = ctx.model?.provider;
    const proxyUrl = enabled && provider ? getProxyUrl(provider) : undefined;
    if (provider && proxyUrl) {
      applyProxy(provider, proxyUrl);
    } else {
      removeProxy();
    }
    updateStatus(ctx);
  });

  // Model changes, including restores, use only the provider for routing.
  pi.on("model_select", async (event, ctx) => {
    handleProviderChange(ctx, event.model.provider);
  });

  // Restore direct traffic and clear all active proxy state on shutdown.
  pi.on("session_shutdown", async () => {
    removeProxy();
  });
}
