# pi-model-proxy

一个按 provider 配置 HTTP 正向代理的 Pi 扩展。同一 provider 下的所有模型共享代理，不需要逐个配置模型。

当前模型所属的 provider 配有代理时，扩展将 Node/undici 的全局 dispatcher 切换到 `ProxyAgent`；切换到未配置代理的 provider 时恢复直连。同一 provider 内切换模型会复用当前代理连接池。

这里配置的是真正的 HTTP 代理，不是改写 provider 的 `baseUrl`。

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

## 配置

创建 `~/.pi/agent/model-proxy.json`：

```json
{
  "providers": {
    "openai-codex": "http://127.0.0.1:7897",
    "anthropic": "http://127.0.0.1:7898"
  }
}
```

键是 provider ID，例如 `openai-codex`、`anthropic` 或自定义 provider ID；值是代理 URL。键中不再包含模型名称。手动编辑配置后，重启 Pi 或运行 `/reload`。

### 旧配置处理

这是不兼容的配置格式变更：旧 `models` 字段及 `provider/modelId` 键已移除，不再读取，也不自动迁移。升级前备份旧配置，再手动改为上面的 `providers` 格式。同一 provider 原来有多个不同代理时，需要自行选择一个。

包名仍为 `pi-model-proxy`，配置文件名仍为 `model-proxy.json`。读取旧文件不会修改它；执行新的 `/proxy set` 命令会按 `providers` 格式重写配置。

## 命令

```text
/proxy
/proxy status
/proxy list
/proxy set openai-codex http://127.0.0.1:7897
/proxy remove openai-codex
```

- `set` 为整个 provider 设置代理；如果当前模型属于该 provider，立即生效。
- `remove` 删除整个 provider 的代理；如果当前正在使用该 provider，立即恢复直连。
- `status` 显示当前 provider、代理及实际路由状态，`list` 按 provider 列出配置。
- 命令不再接受 `provider/modelId` 参数。

## 限制

- HTTPS 请求通过 HTTP CONNECT 隧道传输。
- dispatcher 的变更作用于整个进程，而不是逐请求隔离；当前 provider 的代理生效时，其他使用全局 dispatcher 的请求也会经过它。
- 如果代理出口 IP 被 Cloudflare 封禁，需要更换代理节点；扩展不能解决 Cloudflare 验证问题。

## 开发验证

```bash
npm test
```

测试使用 Node.js 内置测试运行器，不新增依赖。覆盖 provider 切换、同 provider 模型复用、配置读写、旧格式拒绝及关闭时恢复直连，不连接真实模型服务。

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
- 工作流检查版本是否已存在，安装依赖并执行 `npm test`、`npm pack --dry-run` 后发布。仓库目前没有类型检查脚本。

详见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。
