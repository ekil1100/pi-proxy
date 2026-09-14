import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from "undici";

const proxyUrl = "http://127.0.0.1:7897";
const otherProxyUrl = "http://127.0.0.1:7898";
let instance = 0;

// Tests run sequentially because undici's dispatcher is process-global.
async function setup(t, config = { providers: {} }) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-model-proxy-test-"));
  const configPath = join(agentDir, "model-proxy.json");
  writeFileSync(configPath, JSON.stringify(config));

  const directDispatcher = getGlobalDispatcher();
  const events = new Map();
  const commands = new Map();
  const notifications = [];
  const statuses = new Map();
  const ctx = {
    model: { provider: "openai-codex", id: "model-a" },
    ui: {
      notify: (message, level = "info") => notifications.push({ message, level }),
      setStatus: (key, text) => statuses.set(key, text),
      theme: { fg: t.mock.fn((_color, text) => text) },
    },
  };

  t.after(async () => {
    try {
      await events.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    } finally {
      setGlobalDispatcher(directDispatcher);
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  // Pi supplies this host module at runtime. Keep real filesystem and undici behavior.
  const hostUrl = `data:text/javascript,${encodeURIComponent(
    `export const getAgentDir = () => ${JSON.stringify(agentDir)};`,
  )}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@earendil-works/pi-coding-agent") {
        return { url: hostUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  let extension;
  try {
    ({ default: extension } = await import(`../index.ts?test=${instance++}`));
  } finally {
    hooks.deregister();
  }

  extension({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  });

  async function emit(name, event = {}) {
    assert.ok(events.has(name), `Missing event handler: ${name}`);
    await events.get(name)({ type: name, ...event }, ctx);
  }

  return {
    ctx,
    configPath,
    directDispatcher,
    notifications,
    statuses,
    emit,
    command: (args) => commands.get("proxy").handler(args, ctx),
    readConfig: () => JSON.parse(readFileSync(configPath, "utf8")),
    async select(provider, id = "model-b", source = "set") {
      const previousModel = ctx.model;
      ctx.model = { provider, id };
      await emit("model_select", { model: ctx.model, previousModel, source });
    },
  };
}

test("models from one configured provider share the same proxy dispatcher", async (t) => {
  const app = await setup(t, { providers: { "openai-codex": proxyUrl } });
  await app.emit("session_start");
  const dispatcher = getGlobalDispatcher();
  assert.ok(dispatcher instanceof ProxyAgent);
  assert.equal(app.statuses.get("proxy"), "proxy");
  assert.deepEqual(app.ctx.ui.theme.fg.mock.calls.at(-1).arguments, ["warning", "proxy"]);

  await app.select("openai-codex", "a-new-model", "cycle");
  assert.equal(getGlobalDispatcher(), dispatcher);
  assert.equal(app.notifications.length, 0);
});

test("switching providers applies their proxy or restores direct traffic", async (t) => {
  const app = await setup(t, {
    providers: { "openai-codex": proxyUrl, anthropic: otherProxyUrl },
  });
  await app.emit("session_start");
  const firstDispatcher = getGlobalDispatcher();

  await app.select("anthropic");
  assert.ok(getGlobalDispatcher() instanceof ProxyAgent);
  assert.notEqual(getGlobalDispatcher(), firstDispatcher);
  assert.equal(app.statuses.get("proxy"), "proxy");
  await app.command("status");
  assert.match(app.notifications.at(-1).message, new RegExp(otherProxyUrl));

  await app.select("unconfigured-provider");
  assert.equal(getGlobalDispatcher(), app.directDispatcher);
  assert.equal(app.statuses.get("proxy"), undefined);
});

test("restored model selections also synchronize the provider proxy", async (t) => {
  const app = await setup(t, { providers: { anthropic: proxyUrl } });
  await app.emit("session_start");
  assert.equal(getGlobalDispatcher(), app.directDispatcher);

  await app.select("anthropic", "restored-model", "restore");
  const dispatcher = getGlobalDispatcher();
  assert.ok(dispatcher instanceof ProxyAgent);
  await app.select("anthropic", "another-restored-model", "restore");
  assert.equal(getGlobalDispatcher(), dispatcher);
});

test("set persists provider keys and applies updates to every model of that provider", async (t) => {
  const app = await setup(t);
  await app.emit("session_start");
  await app.command(`set openai-codex ${proxyUrl}`);
  assert.deepEqual(app.readConfig(), { providers: { "openai-codex": proxyUrl } });
  const firstDispatcher = getGlobalDispatcher();
  assert.ok(firstDispatcher instanceof ProxyAgent);

  await app.select("openai-codex", "other-model");
  await app.command(`set openai-codex ${proxyUrl}`);
  assert.equal(getGlobalDispatcher(), firstDispatcher);

  await app.command(`set openai-codex ${otherProxyUrl}`);
  const updatedDispatcher = getGlobalDispatcher();
  assert.ok(updatedDispatcher instanceof ProxyAgent);
  assert.notEqual(updatedDispatcher, firstDispatcher);
  assert.deepEqual(app.readConfig(), { providers: { "openai-codex": otherProxyUrl } });
  await app.select("openai-codex", "future-model");
  assert.equal(getGlobalDispatcher(), updatedDispatcher);
});

test("editing another provider leaves the active route unchanged", async (t) => {
  const app = await setup(t, { providers: { "openai-codex": proxyUrl } });
  await app.emit("session_start");
  const dispatcher = getGlobalDispatcher();

  await app.command(`set local-openai ${otherProxyUrl}`);
  assert.deepEqual(app.readConfig(), {
    providers: { "openai-codex": proxyUrl, "local-openai": otherProxyUrl },
  });
  assert.equal(getGlobalDispatcher(), dispatcher);
  await app.command("remove local-openai");
  assert.deepEqual(app.readConfig(), { providers: { "openai-codex": proxyUrl } });
  assert.equal(getGlobalDispatcher(), dispatcher);
});

test("removing the current provider restores direct traffic for all its models", async (t) => {
  const app = await setup(t, {
    providers: { "openai-codex": proxyUrl, anthropic: otherProxyUrl },
  });
  await app.emit("session_start");
  await app.select("openai-codex", "other-model");
  await app.command("remove openai-codex");
  assert.deepEqual(app.readConfig(), { providers: { anthropic: otherProxyUrl } });
  assert.equal(getGlobalDispatcher(), app.directDispatcher);
  assert.equal(app.statuses.get("proxy"), undefined);

  await app.select("openai-codex", "future-model");
  assert.equal(getGlobalDispatcher(), app.directDispatcher);
});

test("status and list describe provider-level configuration", async (t) => {
  const app = await setup(t, { providers: { "openai-codex": proxyUrl } });
  await app.emit("session_start");
  await app.command("status");
  const status = app.notifications.at(-1).message;
  assert.match(status, /Current provider: openai-codex/);
  assert.match(status, /Providers: 1/);
  assert.doesNotMatch(status, /model-a/);

  await app.command("list");
  assert.match(app.notifications.at(-1).message, /^Provider proxy config:\nopenai-codex\s+→ http:\/\/127\.0\.0\.1:7897$/);
});

test("commands and session startup work without a current model or config file", async (t) => {
  const app = await setup(t);
  app.ctx.model = undefined;
  rmSync(app.configPath);
  await app.emit("session_start");
  await app.command("status");
  assert.match(app.notifications.at(-1).message, /Current provider: none/);
  await app.command(`set local-openai ${proxyUrl}`);
  assert.equal(getGlobalDispatcher(), app.directDispatcher);
  assert.deepEqual(app.readConfig(), { providers: { "local-openai": proxyUrl } });

  await app.select("local-openai");
  assert.ok(getGlobalDispatcher() instanceof ProxyAgent);
});

test("legacy model config is rejected without migration and replaced only by an explicit set", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const legacy = { models: { "openai-codex/model-a": proxyUrl } };
  const app = await setup(t, legacy);
  await app.emit("session_start");
  assert.equal(getGlobalDispatcher(), app.directDispatcher);
  assert.deepEqual(app.readConfig(), legacy);
  assert.match(errors.mock.calls[0].arguments[0], /Expected a "providers" object/);

  await app.command(`set openai-codex ${otherProxyUrl}`);
  assert.deepEqual(app.readConfig(), { providers: { "openai-codex": otherProxyUrl } });
  assert.ok(getGlobalDispatcher() instanceof ProxyAgent);
});

test("commands reject model-scoped keys and invalid URLs without changing config", async (t) => {
  const config = { providers: { "openai-codex": proxyUrl } };
  const app = await setup(t, config);
  await app.emit("session_start");
  const dispatcher = getGlobalDispatcher();

  for (const command of [
    `set openai-codex/model-a ${otherProxyUrl}`,
    "remove openai-codex/model-a",
    "set openai-codex not-a-url",
    "set",
    "remove",
  ]) {
    await app.command(command);
    assert.equal(app.notifications.at(-1).level, "error");
    assert.deepEqual(app.readConfig(), config);
    assert.equal(getGlobalDispatcher(), dispatcher);
  }
});

test("invalid provider config shapes and entries are rejected", async (t) => {
  for (const config of [
    null,
    { providers: [] },
    { providers: { "openai-codex/model-a": proxyUrl } },
    { providers: { "openai-codex": 123 } },
    { providers: { "openai-codex": "" } },
    { providers: { "two words": proxyUrl } },
  ]) {
    await t.test(JSON.stringify(config), async (t) => {
      const errors = t.mock.method(console, "error", () => {});
      const app = await setup(t, config);
      await app.emit("session_start");
      assert.equal(getGlobalDispatcher(), app.directDispatcher);
      assert.ok(errors.mock.callCount() > 0);
      assert.deepEqual(app.readConfig(), config);
    });
  }
});

test("provider IDs never resolve inherited object properties", async (t) => {
  const app = await setup(t);
  await app.select("constructor");
  assert.equal(getGlobalDispatcher(), app.directDispatcher);
  await app.command("remove constructor");
  assert.equal(app.notifications.at(-1).level, "warning");

  await app.command(`set __proto__ ${proxyUrl}`);
  assert.equal(Object.hasOwn(app.readConfig().providers, "__proto__"), true);
  await app.select("__proto__");
  assert.ok(getGlobalDispatcher() instanceof ProxyAgent);
  await app.command("remove __proto__");
  assert.deepEqual(app.readConfig(), { providers: {} });
  assert.equal(getGlobalDispatcher(), app.directDispatcher);
});

test("shutdown clears active provider state before the next session", async (t) => {
  const app = await setup(t, { providers: { "openai-codex": proxyUrl } });
  await app.emit("session_start");
  const firstDispatcher = getGlobalDispatcher();
  await app.emit("session_shutdown");
  assert.equal(getGlobalDispatcher(), app.directDispatcher);
  await app.emit("session_shutdown");
  assert.equal(getGlobalDispatcher(), app.directDispatcher);

  await app.emit("session_start");
  assert.ok(getGlobalDispatcher() instanceof ProxyAgent);
  assert.notEqual(getGlobalDispatcher(), firstDispatcher);
  app.ctx.model = undefined;
  await app.emit("session_start");
  assert.equal(getGlobalDispatcher(), app.directDispatcher);
  assert.equal(app.statuses.get("proxy"), undefined);
});
