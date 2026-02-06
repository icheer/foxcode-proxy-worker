# Cloudflare Workers 部署指南

## 快速开始

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
# 或使用 npx
npx wrangler --version
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

这会打开浏览器让你授权 Wrangler 访问你的 Cloudflare 账号。

### 3. 部署 Worker

```bash
npx wrangler deploy
```

部署成功后，你会看到类似的输出：
```
Uploaded foxcode-cache-proxy (x.xx sec)
Published foxcode-cache-proxy (x.xx sec)
  https://foxcode-cache-proxy.your-subdomain.workers.dev
```

### 4. 配置环境变量

#### 方法一：通过 Dashboard

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 Workers & Pages
3. 选择 `foxcode-cache-proxy`
4. 点击 Settings → Variables
5. 添加以下变量：
   - `TARGET_HOST`: `code.newcli.com`
   - `USER_ID`: 你的用户标识（如 `openclaw-user`）
   - `RETRY_MAX`: `3`
   - `RETRY_DELAY`: `1000`
   - `TIMEOUT_MS`: `180000`

#### 方法二：通过 wrangler.toml

编辑 `wrangler.toml` 文件：

```toml
name = "foxcode-cache-proxy"
main = "worker.js"
compatibility_date = "2024-01-01"

[vars]
TARGET_HOST = "code.newcli.com"
USER_ID = "your-user-id"
RETRY_MAX = "3"
RETRY_DELAY = "1000"
TIMEOUT_MS = "180000"
```

然后重新部署：
```bash
npx wrangler deploy
```

### 5. 测试

```bash
# 健康检查
curl https://foxcode-cache-proxy.your-subdomain.workers.dev/health

# 测试 Claude 接口
curl -X POST https://foxcode-cache-proxy.your-subdomain.workers.dev/droid/v1/messages \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-5-sonnet-20241022","messages":[{"role":"user","content":"Hello"}],"max_tokens":100}'
```

## 本地开发

```bash
# 本地运行（使用 Miniflare）
npx wrangler dev

# 访问 http://localhost:8787
```

本地开发时，环境变量可以在 `.dev.vars` 文件中设置：

```env
TARGET_HOST=code.newcli.com
USER_ID=openclaw-user
RETRY_MAX=3
RETRY_DELAY=1000
TIMEOUT_MS=180000
```

## 查看日志

### 实时日志

```bash
npx wrangler tail
```

### Dashboard 日志

1. 进入 Workers & Pages
2. 选择你的 Worker
3. 点击 Logs → Begin log stream

## 更新 Worker

修改代码后，重新部署：

```bash
npx wrangler deploy
```

## 自定义域名（可选）

1. 在 Dashboard 中进入 Worker 设置
2. 点击 Triggers → Custom Domains
3. 添加你的自定义域名（需要先将域名添加到 Cloudflare）

## 性能优化建议

1. **使用 KV 存储**（如果需要持久化会话）：
   ```toml
   [[kv_namespaces]]
   binding = "CACHE_KEYS"
   id = "your-kv-namespace-id"
   ```

2. **启用 Caching**：Worker 自动使用 Cloudflare 的全球 CDN

3. **监控使用情况**：在 Dashboard 中查看请求量和错误率

## 故障排查

### Worker 无响应
- 检查环境变量是否正确配置
- 查看实时日志：`npx wrangler tail`

### 超时错误
- 增加 `TIMEOUT_MS` 值
- 检查 `TARGET_HOST` 是否可访问

### 部署失败
- 确保已登录：`npx wrangler whoami`
- 检查 `wrangler.toml` 语法
- 更新 Wrangler：`npm install -g wrangler@latest`

## 费用说明

Cloudflare Workers 免费套餐包括：
- 每天 100,000 次请求
- 每次请求最多 10ms CPU 时间

对于大多数个人使用场景，免费套餐完全够用。

超出免费额度后：
- $0.50 / 百万次请求
- $12.50 / 百万 GB-s（CPU 时间）

详见：https://developers.cloudflare.com/workers/platform/pricing/
