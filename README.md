# pi-model-proxy

A pi extension for per-model HTTP forward proxy routing.

It switches Node/undici's global dispatcher to a `ProxyAgent` when the active model matches your config, then restores direct traffic when you switch away.

This is for real HTTP proxy traffic, not provider `baseUrl` endpoint rewriting.

## 安装

发布到 npm 后，可直接安装：

```bash
pi install npm:pi-model-proxy
```

也可以从源码安装到 Pi 的扩展目录：

```bash
git clone https://github.com/ekil1100/pi-proxy ~/.pi/agent/extensions/model-proxy
cd ~/.pi/agent/extensions/model-proxy
npm install
```

两种方式任选其一，避免重复加载。安装后重启 Pi 或运行 `/reload`。

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

## 发布到 npm

`.github/workflows/publish-npm.yml` 参考 `pi-auto`，使用 GitHub Actions OIDC（Trusted Publishing），无需保存 `NPM_TOKEN`。

### 首次配置

1. 如果 npm 上尚无此包，需先由有权限的维护者在本地完成首次发布：

   ```bash
   npm ci --ignore-scripts
   npm login
   npm publish --access public
   ```

2. 在 GitHub 仓库设置中创建 `npm` environment，可按需添加发布审批。
3. 在 npm 包 `pi-model-proxy` 的设置中添加 GitHub Actions Trusted Publisher：
   - Organization or user：`ekil1100`
   - Repository：`pi-proxy`
   - Workflow filename：`publish-npm.yml`
   - Environment name：`npm`
   - Allowed actions：允许 `npm publish` 直接发布。

包名必须属于当前维护者，曾发布后下架的版本不能复用。

### 后续发布

更新版本并推送 tag：

```bash
npm version patch
git push origin main --follow-tags
```

- 推送 `v*` tag 自动触发；tag 必须与 `package.json` 的版本完全一致，例如 `v1.0.1`。
- 正式版本发布到 `latest`，含预发布标识的版本自动发布到 `next`。
- 也可在 Actions 页面手动运行，但只能选择 `main`，填写当前 `package.json` 版本，并选择 `latest`、`next` 或 `beta`。
- 工作流检查版本是否已存在，安装依赖并执行 `npm pack --dry-run` 后发布。仓库目前没有测试或类型检查脚本，因此工作流没有这些步骤。

详见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。
