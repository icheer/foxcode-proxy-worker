# Foxcode Unified Cache Proxy

统一代理，为 Foxcode API 请求优化缓存命中率。

## 功能

- ✅ **Claude 渠道** - 注入 `metadata.user_id` 启用 Prompt 缓存
- ✅ **Codex 渠道** - 移除动态时间戳 + 注入 `prompt_cache_key` 稳定前缀缓存
- ✅ **Gemini 渠道** - 移除动态时间戳 + v1beta 路径转换
- ✅ 多渠道路由支持
- ✅ 网络异常自动重试
- ✅ 健康检查端点
- ✅ 流式响应支持
- ✅ **Cloudflare Workers 部署**

## 背景

### Claude 缓存
Foxcode 需要在请求中包含 `metadata.user_id` 字段才能启用 Prompt 缓存。

### Codex 缓存
OpenAI Codex API 使用自动前缀缓存，但 `@mariozechner/pi-coding-agent` 的 `buildSystemPrompt()` 每次请求都注入动态时间戳（`Current date and time: ...`），导致前缀永远不匹配。本代理移除该时间戳以稳定缓存。

### Gemini 缓存
Gemini 2.5+ 支持隐式缓存，同样需要移除动态时间戳。

> ⚠️ **注意：foxcode 中转站的 Gemini 渠道不支持隐式缓存，暂时不可用。其他中转站请自行测试。**

## 部署到 Cloudflare Workers

### 前置要求

- Cloudflare 账号
- 已安装 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### 部署步骤

1. **克隆仓库**

```bash
git clone https://github.com/1034378361/foxcode-cache-proxy.git
cd foxcode-cache-proxy
```

2. **登录 Cloudflare**

```bash
npx wrangler login
```

3. **配置环境变量（可选）**

编辑 `wrangler.toml` 文件，或在 Cloudflare Dashboard 中配置：

```toml
[vars]
TARGET_HOST = "code.newcli.com"
USER_ID = "your-user-id"
RETRY_MAX = "3"
RETRY_DELAY = "1000"
TIMEOUT_MS = "180000"
```

4. **部署到 Cloudflare**

```bash
npx wrangler deploy
```

5. **获取 Worker URL**

部署成功后，你会得到一个类似 `https://foxcode-cache-proxy.your-subdomain.workers.dev` 的 URL。


### 多渠道路由

| 渠道类型 | 路径前缀 | 处理方式 |
|----------|----------|----------|
| Claude | `/droid`, `/aws`, `/super`, `/ultra` | 注入 `metadata.user_id` |
| Codex | `/codex` | 移除时间戳 + 注入 `prompt_cache_key` |
| Gemini | `/gemini` | 移除时间戳 + 添加 `/v1beta` 前缀 |

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TARGET_HOST` | code.newcli.com | Foxcode API 地址 |
| `USER_ID` | openclaw-user | Claude 缓存用户标识 |
| `RETRY_MAX` | 3 | 最大重试次数 |
| `RETRY_DELAY` | 1000 | 初始重试延迟(ms) |
| `TIMEOUT_MS` | 180000 | 请求超时时间(ms) |

在 Cloudflare Dashboard 中设置环境变量：
1. 进入 Workers & Pages
2. 选择你的 Worker
3. 点击 Settings → Variables
4. 添加环境变量


## 配置示例

### OpenClaw

修改 `~/.openclaw/openclaw.json`，使用你的 Worker URL：

```json
{
  "models": {
    "providers": {
      "foxcode-droid": {
        "baseUrl": "https://foxcode-cache-proxy.your-subdomain.workers.dev/droid",
        "apiKey": "your-api-key",
        "api": "anthropic-messages"
      },
      "foxcode-codex": {
        "baseUrl": "https://foxcode-cache-proxy.your-subdomain.workers.dev/codex",
        "apiKey": "your-api-key",
        "api": "openai-responses"
      }
    }
  }
}
```

## 健康检查

```bash
curl https://foxcode-cache-proxy.your-subdomain.workers.dev/health
# {"status":"ok","timestamp":1234567890}
```


## 缓存效果

### Codex 缓存命中示例
在 Cloudflare Workers 日志中查看：
```
🟢 [CACHE] Removed timestamp from instructions (16124 -> 16055)
🟢 [CACHE] Timestamp removed for stable caching
```

### Claude 缓存命中
通过 `metadata.user_id` 启用，缓存信息在 API 响应的 `usage` 字段中。

## 本地开发

如果需要本地测试：

```bash
# 安装依赖
npm install

# 本地运行
npx wrangler dev

# 本地访问 http://localhost:8787
```

## 旧版 Node.js 代理

如果需要使用旧版 Node.js 本地代理（不需要 Cloudflare），请查看 `proxy.js` 文件：

```bash
node proxy.js
```

配置为本地服务（使用 systemd）：
```bash
cp foxcode-proxy.service ~/.config/systemd/user/
systemctl --user enable --now foxcode-proxy
```

## License

MIT
