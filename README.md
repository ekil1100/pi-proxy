# pi-model-proxy

A pi extension for per-model HTTP forward proxy routing.

It switches Node/undici's global dispatcher to a `ProxyAgent` when the active model matches your config, then restores direct traffic when you switch away.

This is for real HTTP proxy traffic, not provider `baseUrl` endpoint rewriting.

## Install

Clone this repo into pi's extension directory:

```bash
git clone https://github.com/ekil1100/pi-proxy ~/.pi/agent/extensions/model-proxy
cd ~/.pi/agent/extensions/model-proxy
npm install
```

Then restart pi or run `/reload`.

## Configure

Create `~/.pi/agent/model-proxy.json`:

```json
{
  "models": {
    "openai-codex/gpt-5.5": "http://127.0.0.1:7897"
  }
}
```

Keys are `provider/modelId`. Values are HTTP proxy URLs.

## Commands

```text
/proxy
/proxy status
/proxy list
/proxy set openai-codex/gpt-5.5 http://127.0.0.1:7897
/proxy remove openai-codex/gpt-5.5
```

## Notes

- HTTPS requests are tunneled through the proxy via HTTP CONNECT.
- The dispatcher change is process-global while the matching model is active.
- If a proxy exit IP is blocked by Cloudflare, change the proxy node; the extension cannot solve Cloudflare challenges.
