/**
 * Foxcode Unified Cache Proxy - Cloudflare Workers Version
 *
 * 统一代理，支持：
 * - Claude API: 注入 metadata.user_id
 * - Codex API: 注入 prompt_cache_key
 * - Gemini API: 移除时间戳 + v1beta 路径
 *
 * @author 琦琦 & 三胖
 */

// ============ 配置 ============
function getConfig(env) {
  return {
    targetHost: env.TARGET_HOST || 'code.newcli.com',
    userId: env.USER_ID || 'openclaw-user',

    // Claude 渠道
    claudeChannels: ['droid', 'aws', 'super', 'ultra'],

    // Codex 渠道
    codexChannels: ['codex'],

    // Gemini 渠道
    geminiChannels: ['gemini'],

    // 重试配置
    retry: {
      maxAttempts: parseInt(env.RETRY_MAX || '3'),
      initialDelayMs: parseInt(env.RETRY_DELAY || '1000'),
      maxDelayMs: parseInt(env.RETRY_MAX_DELAY || '10000')
    },

    timeoutMs: parseInt(env.TIMEOUT_MS || '180000')
  };
}

// ============ 日志 ============
const log = {
  info: msg => console.log(`ℹ️  ${msg}`),
  error: msg => console.error(`❌ ${msg}`),
  success: msg => console.log(`✅ ${msg}`),
  claude: msg => console.log(`🟣 ${msg}`),
  codex: msg => console.log(`🟢 ${msg}`),
  gemini: msg => console.log(`🔵 ${msg}`)
};

// ============ 工具函数 ============
function generateUUID() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 移除系统提示中的时间戳行
 * 匹配格式: "Current date and time: Monday, February 2, 2026 at 12:13:18 PM GMT+8"
 */
function removeTimestamp(text) {
  if (!text || typeof text !== 'string') return text;
  // 匹配 "Current date and time: ..." 整行（包括换行符）
  return text.replace(/\n?Current date and time:[^\n]*/g, '');
}

function getRetryDelay(attempt, config) {
  const delay = config.retry.initialDelayMs * Math.pow(2, attempt);
  return Math.min(delay, config.retry.maxDelayMs);
}

function isRetryableError(error) {
  const retryableStatuses = [408, 429, 500, 502, 503, 504];
  return error.status && retryableStatuses.includes(error.status);
}

// 解析请求类型
function parseRequestType(url, config) {
  const match = url.pathname.match(/^\/([^\/]+)/);
  if (!match) return { type: 'unknown', channel: null };

  const channel = match[1];

  if (config.claudeChannels.includes(channel)) {
    return { type: 'claude', channel };
  }
  if (config.codexChannels.includes(channel)) {
    return { type: 'codex', channel };
  }
  if (config.geminiChannels.includes(channel)) {
    return { type: 'gemini', channel };
  }

  return { type: 'unknown', channel };
}

// ============ 会话缓存 Key 管理（使用 KV 或临时变量）============
// 注意：Workers 中没有持久化 Map，每次请求都是新实例
// 这里使用简单的方式生成 cache key
function getCacheKey(sessionId) {
  return `openclaw-${sessionId}-${generateUUID().slice(0, 8)}`;
}

// ============ 主请求处理 ============
async function handleRequest(request, env) {
  const config = getConfig(env);
  const url = new URL(request.url);

  // 健康检查
  if (url.pathname === '/health' && request.method === 'GET') {
    return new Response(
      JSON.stringify({
        status: 'ok',
        timestamp: Date.now()
      }),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // 处理 GET 请求（查询模型列表等）
  if (request.method === 'GET') {
    return await handleGetRequest(request, url, config);
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { type, channel } = parseRequestType(url, config);

  try {
    const body = await request.text();
    const data = JSON.parse(body);

    if (type === 'claude') {
      return await handleClaudeRequest(data, request, channel, config);
    } else if (type === 'codex') {
      return await handleCodexRequest(data, request, config);
    } else if (type === 'gemini') {
      return await handleGeminiRequest(data, request, url, config);
    } else {
      // 未知类型，直接转发
      return await forwardRaw(body, request, url, config);
    }
  } catch (err) {
    log.error(`Request failed: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============ GET 请求处理 ============
async function handleGetRequest(request, url, config) {
  const { type, channel } = parseRequestType(url, config);

  let targetPath = url.pathname;
  let targetChannel = channel;

  // 如果是标准 Claude API 路径（/v1/models 等），使用默认渠道
  if (url.pathname.startsWith('/v1/')) {
    targetChannel = config.claudeChannels[0]; // 使用 droid 作为默认渠道
    targetPath = `/claude/${targetChannel}${url.pathname}`;
    log.info(`[GET] Standard API path detected, routing to ${targetChannel}`);
  }
  // Gemini 需要添加 v1beta 前缀
  else if (type === 'gemini') {
    targetPath = targetPath.replace(/^\/gemini/, '/gemini/v1beta');
  }
  // Claude 渠道路径
  else if (type === 'claude') {
    targetPath = `/claude/${channel}${url.pathname.replace(/^\/[^\/]+/, '')}`;
    if (!targetPath.includes('/v1/')) {
      targetPath = `/claude/${channel}/v1/models`;
    }
  }

  const targetUrl = `https://${config.targetHost}${targetPath}${url.search}`;

  log.info(`[GET] ${url.pathname} -> ${targetUrl}`);

  try {
    const forwardHeaders = {
      // 添加浏览器特征 headers 以绕过 Cloudflare 检测
      'User-Agent':
        request.headers.get('user-agent') ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site'
    };

    // 传递认证 headers
    if (request.headers.get('authorization')) {
      forwardHeaders['Authorization'] = request.headers.get('authorization');
    }
    if (request.headers.get('x-api-key')) {
      forwardHeaders['x-api-key'] = request.headers.get('x-api-key');
    }
    if (request.headers.get('x-goog-api-key')) {
      forwardHeaders['x-goog-api-key'] = request.headers.get('x-goog-api-key');
    }

    // 传递 Claude 特有的 headers
    if (request.headers.get('anthropic-version')) {
      forwardHeaders['anthropic-version'] =
        request.headers.get('anthropic-version');
    }

    // 传递 Referer 和 Origin（如果有）
    if (request.headers.get('referer')) {
      forwardHeaders['Referer'] = request.headers.get('referer');
    }
    if (request.headers.get('origin')) {
      forwardHeaders['Origin'] = request.headers.get('origin');
    }

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: forwardHeaders
    });

    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, x-api-key, anthropic-version'
      }
    });
  } catch (err) {
    log.error(`GET request failed: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============ Claude 请求处理 ============
async function handleClaudeRequest(data, request, channel, config) {
  // 注入 metadata.user_id
  data.metadata = { ...data.metadata, user_id: config.userId };

  const targetUrl = `https://${config.targetHost}/claude/${channel}/v1/messages`;
  log.claude(
    `[${channel}] model=${data.model}, messages=${data.messages?.length || 0}`
  );

  return await forwardWithRetry(
    data,
    request.headers,
    targetUrl,
    config,
    'claude'
  );
}

// ============ Gemini 请求处理 ============
async function handleGeminiRequest(data, request, url, config) {
  // ===== 移除时间戳以稳定缓存 =====
  let timestampRemoved = false;

  // Gemini 格式：systemInstruction.parts[0].text
  if (data.systemInstruction?.parts?.[0]?.text) {
    const before = data.systemInstruction.parts[0].text.length;
    data.systemInstruction.parts[0].text = removeTimestamp(
      data.systemInstruction.parts[0].text
    );
    if (data.systemInstruction.parts[0].text.length !== before) {
      timestampRemoved = true;
      log.gemini(
        `[CACHE] Removed timestamp from systemInstruction (${before} -> ${data.systemInstruction.parts[0].text.length})`
      );
    }
  }

  if (timestampRemoved) {
    log.gemini(`[CACHE] Timestamp removed for stable caching`);
  }
  // ===== 时间戳移除完成 =====

  // 转发到 Gemini 端点（硬编码 v1beta 前缀）
  // 原始路径: /gemini/models/xxx → 转发到: /gemini/v1beta/models/xxx
  const geminiPath = url.pathname.replace(/^\/gemini/, '/gemini/v1beta');
  const targetUrl = `https://${config.targetHost}${geminiPath}${url.search}`;
  log.gemini(
    `contents=${data.contents?.length || 0}, timestampRemoved=${timestampRemoved}, path=${geminiPath}`
  );

  return await forwardDirect(
    data,
    request.headers,
    targetUrl,
    config,
    log.gemini
  );
}

// ============ Codex 请求处理 ============
async function handleCodexRequest(data, request, config) {
  // 提取会话ID
  const sessionId =
    request.headers.get('x-session-key') ||
    data.metadata?.session_id ||
    data.user ||
    'default';

  // 打印原始请求信息（调试用）
  const originalCacheKey = data.prompt_cache_key;
  log.codex(`[DEBUG] Original prompt_cache_key: ${originalCacheKey || 'none'}`);

  // ===== 移除时间戳以稳定缓存 =====
  let timestampRemoved = false;

  // 1. 处理 instructions 字段
  if (data.instructions && typeof data.instructions === 'string') {
    const before = data.instructions.length;
    data.instructions = removeTimestamp(data.instructions);
    if (data.instructions.length !== before) {
      timestampRemoved = true;
      log.codex(
        `[CACHE] Removed timestamp from instructions (${before} -> ${data.instructions.length})`
      );
    }
  }

  // 2. 处理 input 数组中的 system 消息
  if (Array.isArray(data.input)) {
    for (const msg of data.input) {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        const before = msg.content.length;
        msg.content = removeTimestamp(msg.content);
        if (msg.content.length !== before) {
          timestampRemoved = true;
          log.codex(
            `[CACHE] Removed timestamp from system message (${before} -> ${msg.content.length})`
          );
        }
      }
    }
  }

  if (timestampRemoved) {
    log.codex(`[CACHE] Timestamp removed for stable caching`);
  }
  // ===== 时间戳移除完成 =====

  // 注入 prompt_cache_key
  if (!data.prompt_cache_key) {
    data.prompt_cache_key = getCacheKey(sessionId);
  }

  // 固定转发到 /codex/v1/responses（和 Claude 风格一致）
  const targetUrl = `https://${config.targetHost}/codex/v1/responses`;
  log.codex(
    `[${sessionId}] model=${data.model}, cache_key=${data.prompt_cache_key}, injected=${!originalCacheKey}`
  );

  return await forwardDirect(
    data,
    request.headers,
    targetUrl,
    config,
    log.codex
  );
}

// ============ 转发函数 ============
async function forwardWithRetry(data, headers, targetUrl, config, type) {
  let lastError;

  for (let attempt = 0; attempt < config.retry.maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getRetryDelay(attempt - 1, config);
        log.info(
          `Retry ${attempt}/${config.retry.maxAttempts} after ${delay}ms`
        );
        await sleep(delay);
      }

      return await forwardClaude(data, headers, targetUrl, config);
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === config.retry.maxAttempts - 1)
        throw err;
      log.error(`Attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  throw lastError;
}

async function forwardClaude(data, headers, targetUrl, config) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: headers.get('authorization') || '',
        'anthropic-version': headers.get('anthropic-version') || '2023-06-01',
        'anthropic-beta': headers.get('anthropic-beta') || ''
      },
      body: JSON.stringify(data),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // 返回响应，保持流式传输
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta'
      }
    });
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function forwardDirect(
  data,
  headers,
  targetUrl,
  config,
  logFn = log.codex
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    // 传递所有可能需要的 header
    const forwardHeaders = {
      'Content-Type': 'application/json'
    };

    // 传递 Authorization 或 x-goog-api-key
    if (headers.get('authorization')) {
      forwardHeaders['Authorization'] = headers.get('authorization');
    }
    if (headers.get('x-goog-api-key')) {
      forwardHeaders['x-goog-api-key'] = headers.get('x-goog-api-key');
    }

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(data),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // 记录响应状态
    logFn(`Response ${response.status}`);

    // 对于错误响应，尝试解析错误信息
    if (response.status >= 400) {
      const errorBody = await response.text();
      logFn(`Error body: ${errorBody.slice(0, 500)}`);
      return new Response(errorBody, {
        status: response.status,
        headers: {
          'Content-Type':
            response.headers.get('content-type') || 'application/json'
        }
      });
    }

    // 成功响应，直接返回流
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, x-api-key, x-goog-api-key'
      }
    });
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function forwardRaw(body, request, url, config) {
  const targetUrl = `https://${config.targetHost}${url.pathname}${url.search}`;
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: request.headers.get('authorization') || ''
    },
    body
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('content-type') || 'application/json'
    }
  });
}

// ============ Workers 入口 ============
export default {
  async fetch(request, env, ctx) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-goog-api-key',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    try {
      return await handleRequest(request, env);
    } catch (err) {
      log.error(`Unhandled error: ${err.message}`);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
