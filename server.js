const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const HOST = "127.0.0.1";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3939;
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.join(__dirname, ".cache", "source-atlas");
const CACHE_SCHEMA_VERSION = "v2-mvp-cache-8";
const CACHE_COMPATIBLE_SCHEMAS = new Set([CACHE_SCHEMA_VERSION]);
const NANOBOT_OWNER = "HKUDS";
const NANOBOT_REPO = "nanobot";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
let lastRunLogs = [];
let lastModelLogs = [];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const TEXT_EXTENSIONS = new Set([
  ".py",
  ".md",
  ".txt",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".ini",
  ".sh",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
]);

const EXCLUDED_PARTS = [
  ".git",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "site-packages",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
];

const KEYWORD_RULES = [
  [/(^|[/_.-])(prompt|system_prompt|instruction)([/_.-]|$)/i, "提示词"],
  [/(^|[/_.-])(context|message|messages|history|conversation)([/_.-]|$)/i, "上下文"],
  [/(^|[/_.-])(memory|memories|mem)([/_.-]|$)/i, "记忆"],
  [/(^|[/_.-])(mcp|tool|tools|function_call)([/_.-]|$)/i, "工具"],
  [/(^|[/_.-])(agent|agent_loop|loop|bot)([/_.-]|$)/i, "Agent"],
  [/(^|[/_.-])(llm|model|provider|openai|query|chat|completion)([/_.-]|$)/i, "模型"],
  [/(^|[/_.-])(config|settings|env)([/_.-]|$)/i, "配置"],
  [/(^|[/_.-])(router|api|server|bridge|gateway)([/_.-]|$)/i, "网关"],
  [/(^|[/_.-])(webui|ui|frontend|app)([/_.-]|$)/i, "界面"],
  [/(^|[/_.-])(skill|skills)([/_.-]|$)/i, "技能"],
  [/(^|[/_.-])(task|schedule|timer|cron)([/_.-]|$)/i, "任务"],
  [/(^|[/_.-])(test|tests|spec)([/_.-]|$)/i, "测试"],
  [/(^|[/_.-])(docs|readme|doc)([/_.-]|$)/i, "文档"],
];

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function safePublicPath(targetPath) {
  const resolved = path.resolve(targetPath);
  return resolved === PUBLIC_DIR || resolved.startsWith(`${PUBLIC_DIR}${path.sep}`);
}

async function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  if (!safePublicPath(filePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function extname(filePath) {
  return path.extname(filePath).toLowerCase();
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function isExcluded(filePath) {
  const normalized = normalizePath(filePath);
  return EXCLUDED_PARTS.some((part) => normalized === part || normalized.includes(`/${part}/`) || normalized.startsWith(`${part}/`));
}

function isTextPath(filePath) {
  return TEXT_EXTENSIONS.has(extname(filePath));
}

function inferPathKeyword(value) {
  const normalized = value.toLowerCase();
  if (path.basename(normalized) === "__init__.py") {
    return "包入口";
  }
  const exactRules = new Map([
    [".github", "仓库配置"],
    ["bridge", "前端桥接"],
    ["docs", "说明文档"],
    ["nanobot", "主程序"],
    ["api", "接口层"],
    ["bus", "消息总线"],
    ["cli", "命令入口"],
    ["command", "命令集"],
    ["commands", "命令集"],
    ["channels", "聊天通道"],
    ["providers", "模型提供商"],
    ["skills", "技能库"],
    ["subagent", "子代理"],
    ["tools", "工具集"],
    ["autocompact", "自动压缩"],
    ["hook", "回调钩子"],
    ["memory", "记忆存储"],
    ["runner", "代理运行器"],
    ["loop", "代理主循环"],
    ["context", "上下文构建"],
    ["configuration", "配置说明"],
    ["readme", "项目说明"],
    ["package", "依赖配置"],
  ]);
  const rawBaseName = path.basename(normalized);
  const baseName = rawBaseName.replace(/\.[^.]+$/, "");
  if (exactRules.has(rawBaseName)) {
    return exactRules.get(rawBaseName);
  }
  if (exactRules.has(baseName)) {
    return exactRules.get(baseName);
  }
  const hit = KEYWORD_RULES.find(([pattern]) => pattern.test(normalized));
  if (hit) {
    return hit[1];
  }
  const segments = baseName.split(/[_-]+/).filter(Boolean);
  if (segments.length > 1) {
    const mapped = segments.map((segment) => exactRules.get(segment) || "");
    const firstKnown = mapped.find(Boolean);
    if (firstKnown) {
      return firstKnown;
    }
  }
  if (/^[a-z0-9._-]+$/i.test(baseName)) {
    return "";
  }
  return "";
}

function inferFunctionKeyword(name) {
  const normalized = name.toLowerCase();
  const rules = [
    [/_build_request_kwargs/, "组装模型参数"],
    [/_request_model/, "请求 LLM"],
    [/_execute_tools/, "执行 tools"],
    [/_run_tool/, "运行单个 tool"],
    [/_stream_progress/, "处理流式进度"],
    [/_stream$/, "转发流式文本"],
    [/_usage_dict/, "整理用量"],
    [/_merge_usage/, "合并用量"],
    [/build_system_prompt/, "构建 system prompt"],
    [/build_messages/, "组装 messages"],
    [/_get_identity/, "生成 agent 身份"],
    [/_load_bootstrap_files/, "读取引导文件"],
    [/_merge.*messages?|merge.*messages?/, "合并 messages"],
    [/save_turn/, "保存对话轮次"],
    [/read_memory/, "读取 memory"],
    [/write_memory/, "写入 memory"],
    [/get.*memory.*context/, "生成 memory context"],
    [/always.*skills?|get_always_skills/, "读取 always skills"],
    [/load.*skills?.*context/, "加载 skills 上下文"],
    [/build.*skills?.*summary/, "生成 skills 摘要"],
    [/drain.*injection|try_drain/, "取出注入消息"],
    [/process_direct/, "处理直接消息"],
    [/checkpoint/, "写入检查点"],
    [/restore.*runtime/, "恢复运行状态"],
    [/restore.*pending/, "恢复待处理输入"],
    [/sanitize.*persisted/, "清理持久状态"],
    [/system.*prompt|prompt/, "构建 prompt"],
    [/history|conversation/, "读取 history"],
    [/memory|memories/, "处理 memory"],
    [/tool|mcp|function_call/, "处理 tools"],
    [/llm|model|provider|completion|chat|query/, "调用 LLM"],
    [/skill/, "处理 skills"],
    [/schedule|timer|cron|task/, "处理定时任务"],
  ];
  const hit = rules.find(([pattern]) => pattern.test(normalized));
  if (hit) {
    return hit[1];
  }
  return "";
}

function scorePath(filePath, size = 0) {
  const normalized = filePath.toLowerCase();
  const depth = normalized.split("/").length - 1;
  if (isExcluded(normalized) || !isTextPath(normalized)) {
    return -1000;
  }

  let score = 10;
  const base = path.basename(normalized);
  if (base === "__init__.py") score -= 40;
  if (normalized.startsWith("nanobot/")) score += 35;
  if (/agent|llm|model|prompt|context|memory|mcp|tool|bridge|bot/.test(normalized)) score += 34;
  if (/main|server|app|cli|run|query|chat|config/.test(base)) score += 18;
  if (base === "readme.md" || base === "pyproject.toml" || base === "requirements.txt") score += 22;
  if (/test|docs|example|assets|webui/.test(normalized)) score -= 12;
  if (depth <= 2) score += 8;
  if (depth >= 5) score -= 6;
  if (size > 160000) score -= 40;
  return score;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "nanobot-source-learning-page",
          Accept: "application/vnd.github+json",
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      throw new Error(`Network request failed: ${url} (${error.cause?.message || error.message})`);
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(data?.message || `HTTP ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "nanobot-source-learning-page",
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      throw new Error(`Network request failed: ${url} (${error.cause?.message || error.message})`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeGitHubContent(encoded) {
  return Buffer.from((encoded || "").replace(/\n/g, ""), "base64").toString("utf8");
}

function encodeRawPath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

async function fetchNanobotContext() {
  const repoMeta = await fetchJson(`https://api.github.com/repos/${NANOBOT_OWNER}/${NANOBOT_REPO}`);
  const refData = await fetchJson(`https://api.github.com/repos/${NANOBOT_OWNER}/${NANOBOT_REPO}/git/ref/heads/${repoMeta.default_branch}`);
  const commitData = await fetchJson(`https://api.github.com/repos/${NANOBOT_OWNER}/${NANOBOT_REPO}/git/commits/${refData.object.sha}`);
  const treeData = await fetchJson(`https://api.github.com/repos/${NANOBOT_OWNER}/${NANOBOT_REPO}/git/trees/${commitData.tree.sha}?recursive=1`);

  let readme = "";
  try {
    const readmeData = await fetchJson(`https://api.github.com/repos/${NANOBOT_OWNER}/${NANOBOT_REPO}/readme`);
    readme = decodeGitHubContent(readmeData.content);
  } catch {
    readme = "";
  }

  return {
    repo: {
      owner: NANOBOT_OWNER,
      name: NANOBOT_REPO,
      fullName: `${NANOBOT_OWNER}/${NANOBOT_REPO}`,
      url: repoMeta.html_url,
      defaultBranch: repoMeta.default_branch,
      description: repoMeta.description || "",
      topics: repoMeta.topics || [],
      stars: repoMeta.stargazers_count || 0,
    },
    readme,
    tree: Array.isArray(treeData.tree) ? treeData.tree : [],
    truncated: Boolean(treeData.truncated),
  };
}

async function readLocalContext(rootPath) {
  const resolvedRoot = path.resolve(rootPath || "");
  const stat = await fs.stat(resolvedRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Local path is not a directory: ${resolvedRoot}`);
  }

  const tree = [];
  await walkLocalTree(resolvedRoot, resolvedRoot, tree);

  let readme = "";
  for (const candidate of ["README.md", "readme.md", "README.rst", "README.txt"]) {
    try {
      readme = await fs.readFile(path.join(resolvedRoot, candidate), "utf8");
      break;
    } catch {
      // Try the next common README name.
    }
  }

  return {
    repo: {
      owner: "local",
      name: path.basename(resolvedRoot),
      fullName: `local/${path.basename(resolvedRoot)}`,
      url: resolvedRoot,
      defaultBranch: "local",
      description: "Local source project",
      topics: [],
      stars: 0,
      rootPath: resolvedRoot,
    },
    readme,
    tree,
    truncated: false,
    localRoot: resolvedRoot,
  };
}

async function walkLocalTree(rootPath, currentPath, tree) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = normalizePath(path.relative(rootPath, absolutePath));
    if (!relativePath || isExcluded(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      tree.push({ path: relativePath, type: "tree", size: 0, sha: "" });
      await walkLocalTree(rootPath, absolutePath, tree);
      continue;
    }
    if (entry.isFile()) {
      const stat = await fs.stat(absolutePath);
      tree.push({ path: relativePath, type: "blob", size: stat.size, sha: "" });
    }
  }
}

async function fetchRepoFile(context, filePath) {
  if (context.localRoot) {
    const resolved = path.resolve(context.localRoot, filePath);
    const relative = path.relative(context.localRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to read outside local root: ${filePath}`);
    }
    return fs.readFile(resolved, "utf8");
  }

  const rawUrl = `https://raw.githubusercontent.com/${NANOBOT_OWNER}/${NANOBOT_REPO}/${context.repo.defaultBranch}/${encodeRawPath(filePath)}`;
  try {
    return await fetchText(rawUrl);
  } catch {
    const contentData = await fetchJson(`https://api.github.com/repos/${NANOBOT_OWNER}/${NANOBOT_REPO}/contents/${encodeRawPath(filePath)}?ref=${encodeURIComponent(context.repo.defaultBranch)}`);
    return decodeGitHubContent(contentData.content);
  }
}

function summarizeTree(tree) {
  const files = tree
    .filter((item) => item.type === "blob" && !isExcluded(item.path))
    .map((item) => ({
      path: item.path,
      size: item.size || 0,
      extension: extname(item.path),
      score: scorePath(item.path, item.size || 0),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const directories = new Map();
  for (const item of tree) {
    const parts = item.path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const dirPath = parts.slice(0, i).join("/");
      if (!isExcluded(dirPath)) {
        directories.set(dirPath, (directories.get(dirPath) || 0) + 1);
      }
    }
  }

  return {
    files,
    directories: [...directories.entries()]
      .map(([pathValue, count]) => ({
        path: pathValue,
        count,
        score: scorePath(pathValue, 0),
      }))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)),
  };
}

async function fetchSupportFiles(context, files) {
  const supportPaths = files
    .filter((file) => {
      const base = path.basename(file.path).toLowerCase();
      return base === "pyproject.toml" || base === "requirements.txt" || base === "setup.py" || base === "package.json" || file.path.toLowerCase().startsWith("docs/");
    })
    .slice(0, 10)
    .map((file) => file.path);

  return mapLimit(supportPaths, 6, async (filePath) => {
    try {
      const content = await fetchRepoFile(context, filePath);
      return {
        path: filePath,
        content: clip(content, 4000),
      };
    } catch {
      return {
        path: filePath,
        content: "",
      };
    }
  });
}

async function fetchPythonSources(context, files) {
  const pythonPaths = files
    .filter((file) => file.path.endsWith(".py") && file.score > -50 && file.size < 220000)
    .slice(0, 50)
    .map((file) => file.path);

  const sources = await mapLimit(pythonPaths, 8, async (filePath) => {
    try {
      const content = await fetchRepoFile(context, filePath);
      return {
        path: filePath,
        content,
        lines: content.split(/\r?\n/),
      };
    } catch {
      // Keep the pipeline resilient when a raw file cannot be fetched.
      return null;
    }
  });
  return sources.filter(Boolean);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function lineIndent(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].replace(/\t/g, "    ").length : 0;
}

function parsePythonFunctions(source) {
  const functions = [];
  const classStack = [];
  const lines = source.lines;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(\s*)(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[\(:]/);
    if (!match) {
      continue;
    }

    const indent = match[1].replace(/\t/g, "    ").length;
    const kind = match[2].includes("class") ? "class" : "function";
    const name = match[3];

    while (classStack.length && classStack[classStack.length - 1].indent >= indent) {
      classStack.pop();
    }

    let endLine = lines.length;
    let signatureClosed = line.trimEnd().endsWith(":");
    let parenBalance = countChar(line, "(") - countChar(line, ")");
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const scanLine = lines[scan];
      if (!scanLine.trim()) {
        continue;
      }
      if (!signatureClosed) {
        parenBalance += countChar(scanLine, "(") - countChar(scanLine, ")");
        if (parenBalance <= 0 && scanLine.trimEnd().endsWith(":")) {
          signatureClosed = true;
        }
        continue;
      }
      const scanIndent = lineIndent(scanLine);
      if (scanIndent <= indent && !scanLine.trim().startsWith("#")) {
        endLine = scan;
        break;
      }
    }

    if (kind === "class") {
      classStack.push({ name, indent });
      continue;
    }

    const classPrefix = classStack.length ? `${classStack[classStack.length - 1].name}.` : "";
    const fullName = `${classPrefix}${name}`;
    const startLine = index + 1;
    const body = lines.slice(index, endLine).join("\n");
    const calls = [...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
      .map((item) => item[1])
      .filter((item) => !["if", "for", "while", "return", "with", "print", "len", "str", "int", "float", "list", "dict", "set", "tuple", "super"].includes(item));

    functions.push({
      id: `fn-${safeId(`${source.path}-${fullName}-${startLine}`)}`,
      file: source.path,
      name,
      fullName,
      label: inferFunctionKeyword(fullName),
      importance: scorePath(`${source.path}/${fullName}`, 0) > 42 ? "core" : "normal",
      startLine,
      endLine,
      calls: [...new Set(calls)].slice(0, 40),
      isKey: false,
    });
  }

  return functions;
}

function countChar(value, char) {
  return [...value].filter((item) => item === char).length;
}

function buildCallSites(functions, sources) {
  const byName = new Map();
  for (const fn of functions) {
    if (!byName.has(fn.name)) {
      byName.set(fn.name, []);
    }
    byName.get(fn.name).push(fn);
  }

  for (const fn of functions) {
    const sites = [];
    for (const source of sources) {
      for (let index = 0; index < source.lines.length; index += 1) {
        const line = source.lines[index];
        if (!line.includes(`${fn.name}(`)) {
          continue;
        }
        if (source.path === fn.file && index + 1 >= fn.startLine && index + 1 <= Math.min(fn.startLine + 2, fn.endLine)) {
          continue;
        }
        sites.push({
          file: source.path,
          startLine: index + 1,
          endLine: index + 1,
          kind: "callSite",
        });
        if (sites.length >= 5) {
          break;
        }
      }
      if (sites.length >= 5) {
        break;
      }
    }
    fn.callSites = sites;
  }

  return byName;
}

function buildFunctionIndex(sources) {
  const functions = sources.flatMap(parsePythonFunctions);
  buildCallSites(functions, sources);
  return functions;
}

function clip(text, maxLength) {
  if (!text) {
    return "";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...[truncated]` : text;
}

function isMostlyAscii(text) {
  return /^[\x00-\x7F\s.,:;!?()/_-]+$/.test(String(text || ""));
}

function normalizeShortLabel(label, fallback, maxLength = 10) {
  const value = String(label || "").trim();
  if (!value || isMostlyAscii(value)) {
    return String(fallback || "").slice(0, maxLength);
  }
  return value.slice(0, maxLength);
}

const WEAK_FUNCTION_LABELS = new Set([
  "循环",
  "历史",
  "读取",
  "构造",
  "执行步骤",
  "消息处理",
  "追加消息",
  "队列消费",
  "状态",
  "工具",
  "模型",
  "格式",
  "解析",
  "任务",
  "源码",
]);

function normalizeFunctionLabel(label, fallback = "", maxLength = 10) {
  const value = normalizeShortLabel(label, fallback, maxLength);
  if (!value || WEAK_FUNCTION_LABELS.has(value)) {
    return "";
  }
  if (/^(循环|历史|读取|构造|执行|处理|追加|状态|工具|模型|格式|解析)$/.test(value)) {
    return "";
  }
  return value;
}

function analysisCacheDescriptor(input) {
  const source = input.source === "local" ? "local" : "github";
  return {
    schema: CACHE_SCHEMA_VERSION,
    source,
    target: source === "local"
      ? path.resolve(input.localPath || "")
      : `https://github.com/${NANOBOT_OWNER}/${NANOBOT_REPO}`,
    baseUrl: input.baseUrl || DEFAULT_BASE_URL,
    model: input.model || DEFAULT_MODEL,
    llmEnabled: Boolean(input.apiKey),
  };
}

function analysisCachePath(input) {
  const descriptor = analysisCacheDescriptor(input);
  return {
    descriptor,
    filePath: cacheFilePathForDescriptor(descriptor),
  };
}

function cacheFilePathForDescriptor(descriptor) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(descriptor)).digest("hex").slice(0, 24);
  return path.join(CACHE_DIR, `${digest}.json`);
}

async function readAnalysisCache(input) {
  const { descriptor, filePath } = analysisCachePath(input);
  const candidates = [filePath];
  for (const schema of CACHE_COMPATIBLE_SCHEMAS) {
    const legacyPath = cacheFilePathForDescriptor({ ...descriptor, schema });
    if (!candidates.includes(legacyPath)) {
      candidates.push(legacyPath);
    }
  }

  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (!CACHE_COMPATIBLE_SCHEMAS.has(payload?.descriptor?.schema)) {
        continue;
      }
      repairCachedResultFromModelLogs(payload);
      payload.cacheFilePath = candidate;
      return payload;
    } catch {
      // Try the next compatible cache key.
    }
  }
  return null;
}

async function writeAnalysisCache(input, result, modelLogs) {
  const { descriptor, filePath } = analysisCachePath(input);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const savedAt = new Date().toISOString();
  const cacheId = crypto.createHash("sha256")
    .update(`${JSON.stringify(descriptor)}:${savedAt}`)
    .digest("hex")
    .slice(0, 24);
  const payload = {
    cacheId,
    descriptor,
    savedAt,
    result,
    modelLogs,
  };
  const historyPath = path.join(CACHE_DIR, `${cacheId}.history.json`);
  await fs.writeFile(historyPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return historyPath;
}

async function listAnalysisHistory() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const entries = await fs.readdir(CACHE_DIR, { withFileTypes: true });
    const seen = new Set();
    const history = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const fullPath = path.join(CACHE_DIR, entry.name);
        const payload = JSON.parse(await fs.readFile(fullPath, "utf8"));
        const id = payload.cacheId || entry.name.replace(/\.json$/, "");
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        history.push({
          id,
          fileName: entry.name,
          savedAt: payload.savedAt || "",
          schema: payload.descriptor?.schema || "",
          source: payload.descriptor?.source || "",
          target: payload.descriptor?.target || "",
          model: payload.descriptor?.model || "",
          baseUrl: payload.descriptor?.baseUrl || "",
          llmEnabled: Boolean(payload.descriptor?.llmEnabled),
          projectName: payload.result?.project?.name || "",
          functions: payload.result?.functions?.length || 0,
          annotations: payload.result?.keyAnnotations?.length || 0,
          modelCalls: payload.modelLogs?.length || 0,
        });
      } catch {
        // Ignore broken cache files.
      }
    }
    return history.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  } catch {
    return [];
  }
}

async function readHistoryById(id) {
  const safeId = String(id || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeId) {
    return null;
  }
  const candidates = [
    path.join(CACHE_DIR, `${safeId}.history.json`),
    path.join(CACHE_DIR, `${safeId}.json`),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (!resolved.startsWith(path.resolve(CACHE_DIR))) {
        continue;
      }
      const payload = JSON.parse(await fs.readFile(resolved, "utf8"));
      repairCachedResultFromModelLogs(payload);
      payload.cacheFilePath = resolved;
      return payload;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function repairCachedResultFromModelLogs(payload) {
  const result = payload?.result;
  const annotationCall = (payload?.modelLogs || []).find((call) => call.stage === "annotations");
  const rawAnnotations = annotationCall?.parsedJson?.keyAnnotations;
  if (!result || !Array.isArray(rawAnnotations) || !rawAnnotations.length) {
    return;
  }

  const currentLooksFallback = (result.keyAnnotations || []).some((item) =>
    item?.floatingPanel?.variables?.note === "本地索引已定位该关键函数；等待 LLM 补充变量流。"
  );
  if (!currentLooksFallback) {
    return;
  }

  const sources = (result.files || [])
    .filter((file) => file.content)
    .map((file) => ({
      path: file.path,
      content: file.content,
      lines: String(file.content).split(/\r?\n/),
    }));
  const repaired = sanitizeAnnotations(rawAnnotations, result.functions || [], sources);
  if (repaired.length) {
    result.keyAnnotations = repaired;
    result.functions = hydrateFunctionLabels(result.functions || [], result.treeNotes || [], repaired);
    payload.repairedFromModelLogs = true;
  }
}

function localTreeNotes(summary) {
  const directoryNotes = summary.directories.slice(0, 80).map((dir) => ({
    path: dir.path,
    type: "directory",
    label: inferPathKeyword(dir.path),
    importance: dir.score > 40 ? "core" : "normal",
  }));

  const fileNotes = summary.files.slice(0, 120).map((file) => ({
    path: file.path,
    type: "file",
    label: inferPathKeyword(file.path),
    importance: file.score > 48 ? "core" : "normal",
  }));

  return [...directoryNotes, ...fileNotes];
}

function localFlowTabs(functions) {
  const scoreFn = (fn, patterns) => {
    if (path.basename(fn.file).toLowerCase() === "__init__.py") {
      return -100;
    }
    const haystack = `${fn.file}/${fn.fullName}`.toLowerCase();
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(haystack)) score += 10;
    }
    if (fn.callSites?.length) score += 3;
    if (fn.file.startsWith("nanobot/")) score += 2;
    if (fn.fullName.startsWith("_")) score -= 4;
    return score;
  };
  const used = new Set();
  const pick = (patterns, limit = 4) => functions
    .map((fn) => ({ fn, score: scoreFn(fn, patterns) }))
    .filter((item) => item.score > 0 && !used.has(item.fn.id))
    .sort((a, b) => b.score - a.score || b.fn.endLine - b.fn.startLine - (a.fn.endLine - a.fn.startLine))
    .slice(0, limit)
    .map((item) => {
      used.add(item.fn.id);
      return item.fn;
    });

  const makeCard = (id, title, summary, picked) => ({
    id,
    title,
    summary,
    functions: picked.map((fn) => ({
      functionId: fn.id,
      displayName: fn.fullName,
      target: {
        file: fn.callSites?.[0]?.file || fn.file,
        startLine: fn.callSites?.[0]?.startLine || fn.startLine,
        endLine: fn.callSites?.[0]?.endLine || fn.startLine,
        kind: fn.callSites?.[0] ? "callSite" : "definition",
      },
    })),
  });

  return [
    { id: "overview", label: "总览", cards: [] },
    {
      id: "prompt",
      label: "Prompt",
      cards: [
        makeCard("prompt-system", "系统提示词", "设定模型身份、任务边界和行为规则。", pick([/prompt/i, /system/i, /instruction/i])),
        makeCard("prompt-tools", "工具说明", "把可用工具和调用格式描述给模型。", pick([/(^|[/_.-])tools?($|[/_.-])/i, /mcp/i, /schema/i])),
        makeCard("prompt-format", "格式要求", "约束模型输出结构，方便程序解析。", pick([/json/i, /format/i, /schema/i])),
      ],
    },
    {
      id: "context",
      label: "Context",
      cards: [
        makeCard("context-history", "对话历史", "把历史消息放进模型输入。", pick([/history/i, /conversation/i, /messages?/i])),
        makeCard("context-memory", "记忆注入", "把长期或会话记忆合并到上下文。", pick([/memory/i, /remember/i])),
        makeCard("context-files", "文件上下文", "把项目文件或检索材料提供给模型。", pick([/(^|[/_.-])context($|[/_.-])/i, /document/i, /knowledge/i])),
      ],
    },
    {
      id: "harness",
      label: "Harness",
      cards: [
        makeCard("harness-loop", "Agent 循环", "驱动模型、工具和状态不断迭代。", pick([/agent.*loop/i, /run.*agent/i, /chat/i, /step/i], 5)),
        makeCard("harness-model", "模型请求", "向模型服务发起一次对话请求。", pick([/llm/i, /model/i, /query/i, /completion/i, /provider/i], 5)),
        makeCard("harness-tools", "工具执行", "解析工具调用并把结果回填给模型。", pick([/(^|[/_.-])tools?($|[/_.-])/i, /mcp/i, /execute/i, /function_call/i], 5)),
        makeCard("harness-fallback", "兜底策略", "处理重试、解析失败和异常返回。", pick([/retry/i, /fallback/i, /error/i, /repair/i, /exception/i], 4)),
      ],
    },
  ];
}

function flowFunctionIds(flowTabs) {
  const ids = new Set();
  for (const tab of flowTabs) {
    for (const card of tab.cards || []) {
      for (const fn of card.functions || []) {
        if (fn.functionId) {
          ids.add(fn.functionId);
        }
      }
    }
  }
  return ids;
}

function localAnnotations(functions, flowTabs) {
  const ids = flowFunctionIds(flowTabs);
  return functions
    .filter((fn) => ids.has(fn.id))
    .slice(0, 16)
    .map((fn) => {
      const width = Math.max(1, fn.endLine - fn.startLine + 1);
      const firstBlockEnd = Math.min(fn.endLine, fn.startLine + Math.min(10, width - 1));
      return {
        functionId: fn.id,
        file: fn.file,
        functionRange: {
          startLine: fn.startLine,
          endLine: fn.endLine,
        },
        floatingPanel: {
          scenarioFlow: {
            scenario: "本地索引已定位这个关键函数；需要 LLM 补充它属于哪个学习场景。",
            summary: "等待 LLM 补充：这段函数什么时候执行、拿什么数据、如何处理、输出给谁。",
            steps: [],
            output: "等待 LLM 补充场景数据流。",
          },
          variables: {
            flows: [
              {
                name: fn.name,
                label: "关键执行",
                before: "函数收到调用参数",
                sources: [],
                after: "完成该函数负责的核心步骤",
                effect: "等待 LLM 补充更具体的数据流。"
              }
            ],
            note: "本地索引已定位该关键函数；等待 LLM 补充更具体的数据流。"
          },
        },
        highlightVariables: [],
        blocks: [
          {
            id: `block-${fn.id}-entry`,
            startLine: fn.startLine,
            endLine: firstBlockEnd,
            label: "关键入口"
          }
        ],
      };
    });
}

function sanitizeFlowTabs(rawTabs, functions) {
  const functionById = new Map(functions.map((fn) => [fn.id, fn]));
  const existingTabs = new Map(["overview", "prompt", "context", "harness"].map((id) => [id, { id, label: id === "overview" ? "总览" : id[0].toUpperCase() + id.slice(1), cards: [] }]));

  for (const rawTab of Array.isArray(rawTabs) ? rawTabs : []) {
    const id = String(rawTab?.id || "").toLowerCase();
    if (!existingTabs.has(id)) {
      continue;
    }
    const tab = existingTabs.get(id);
    tab.cards = (Array.isArray(rawTab.cards) ? rawTab.cards : []).slice(0, 8).map((rawCard, cardIndex) => ({
      id: String(rawCard?.id || `${id}-card-${cardIndex}`),
      title: String(rawCard?.title || "步骤").slice(0, 18),
      summary: String(rawCard?.summary || "").slice(0, 90),
      functions: (Array.isArray(rawCard?.functions) ? rawCard.functions : []).slice(0, 8).map((rawFn) => {
        const fn = functionById.get(String(rawFn?.functionId || ""));
        if (!fn) {
          return null;
        }
        const target = rawFn?.target || {};
        const validTarget = target.file && Number(target.startLine) > 0 ? target : null;
        return {
          functionId: fn.id,
          displayName: String(rawFn?.displayName || fn.fullName),
          target: validTarget ? {
            file: String(target.file),
            startLine: Number(target.startLine),
            endLine: Number(target.endLine) || Number(target.startLine),
            kind: String(target.kind || "callSite"),
          } : {
            file: fn.callSites?.[0]?.file || fn.file,
            startLine: fn.callSites?.[0]?.startLine || fn.startLine,
            endLine: fn.callSites?.[0]?.endLine || fn.startLine,
            kind: fn.callSites?.[0] ? "callSite" : "definition",
          },
        };
      }).filter(Boolean),
    })).filter((card) => card.functions.length > 0 || id !== "overview");
  }

  existingTabs.get("overview").cards = [];
  return ["overview", "prompt", "context", "harness"].map((id) => existingTabs.get(id));
}

function sanitizeLearningScenarios(rawScenarios, functions) {
  const functionIds = new Set(functions.map((fn) => fn.id));
  return (Array.isArray(rawScenarios) ? rawScenarios : []).slice(0, 24).map((raw, index) => {
    const layer = String(raw?.layer || "").toLowerCase();
    if (!["prompt", "context", "harness"].includes(layer)) {
      return null;
    }
    const entryFunctionIds = (Array.isArray(raw?.entryFunctionIds) ? raw.entryFunctionIds : [])
      .map(String)
      .filter((id) => functionIds.has(id))
      .slice(0, 8);
    if (!entryFunctionIds.length) {
      return null;
    }
    return {
      id: String(raw?.id || `${layer}-scenario-${index}`).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48),
      layer,
      title: String(raw?.title || "学习场景").slice(0, 24),
      userQuestion: String(raw?.userQuestion || "").slice(0, 140),
      entryFunctionIds,
      dataInputs: strings(raw?.dataInputs).slice(0, 8),
      output: String(raw?.output || "").slice(0, 140),
      whyImportant: String(raw?.whyImportant || "").slice(0, 180),
    };
  }).filter(Boolean);
}

function scenariosForFunction(learningScenarios, functionId) {
  return (learningScenarios || []).filter((scenario) => scenario.entryFunctionIds.includes(functionId));
}

function localLearningScenarios(flowTabs) {
  return (flowTabs || []).flatMap((tab) => (tab.cards || []).map((card) => ({
    id: card.id,
    layer: tab.id,
    title: card.title,
    userQuestion: card.summary || "",
    entryFunctionIds: (card.functions || []).map((fn) => fn.functionId).filter(Boolean).slice(0, 8),
    dataInputs: [],
    output: "",
    whyImportant: "本地规则定位的学习入口；等待 LLM 补充场景说明。",
  }))).filter((scenario) => ["prompt", "context", "harness"].includes(scenario.layer) && scenario.entryFunctionIds.length);
}

function sanitizeAnnotations(rawAnnotations, functions, sources) {
  const functionById = new Map(functions.map((fn) => [fn.id, fn]));
  const sourceByPath = new Map(sources.map((source) => [source.path, source]));

  return (Array.isArray(rawAnnotations) ? rawAnnotations : []).map((raw) => {
    const fn = functionById.get(String(raw?.functionId || ""));
    if (!fn) {
      return null;
    }
    const source = sourceByPath.get(fn.file);
    const lineCount = source?.lines.length || fn.endLine;
    const functionStart = clampLine(raw?.functionRange?.startLine, fn.startLine, fn.startLine, fn.endLine, lineCount);
    const functionEnd = clampLine(raw?.functionRange?.endLine, fn.endLine, functionStart, fn.endLine, lineCount);
    const rangeText = source?.lines.slice(functionStart - 1, functionEnd).join("\n") || "";
    const scenarioFlow = sanitizeScenarioFlow(
      raw?.floatingPanel?.scenarioFlow || raw?.scenarioFlow,
      functionStart,
      functionEnd,
      lineCount,
      clampLine,
    );
    const variableFlows = sanitizeVariableFlows(raw?.floatingPanel?.variables?.flows || raw?.variableFlows, raw?.floatingPanel?.variables);
    const scenarioVariableNames = scenarioFlow
      ? [
        ...(scenarioFlow.steps || []).flatMap((step) => [...(step.takes || []), step.produces]),
        scenarioFlow.output,
      ]
      : [];
    const flowVariableNames = variableFlows.flatMap((flow) => [flow.name, ...(flow.sources || [])])
      .map(extractVariableName)
      .filter(Boolean);
    const fallbackVariableNames = (Array.isArray(raw?.highlightVariables) ? raw.highlightVariables : [])
      .map(extractVariableName)
      .filter(Boolean);
    const variables = [...new Set([...scenarioVariableNames, ...flowVariableNames, ...fallbackVariableNames])]
      .map(extractVariableName)
      .filter((name) => isValuableVariableName(name))
      .filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(rangeText))
      .slice(0, 4);
    const rawBlocks = scenarioFlow?.steps?.length
      ? scenarioFlow.steps.map((step, index) => ({
        id: `step-${fn.id}-${index}`,
        startLine: step.startLine,
        endLine: step.endLine,
        label: step.title,
      }))
      : (Array.isArray(raw?.blocks) ? raw.blocks : []);

    return {
      functionId: fn.id,
      file: fn.file,
      functionRange: {
        startLine: functionStart,
        endLine: functionEnd,
      },
      floatingPanel: {
        ...(scenarioFlow ? { scenarioFlow } : {}),
        variables: {
          flows: variableFlows,
          note: String(raw?.floatingPanel?.variables?.note || "").slice(0, 240),
        },
      },
      highlightVariables: variables,
      blocks: rawBlocks.slice(0, 8).map((block, index) => {
        const startLine = clampLine(block?.startLine, functionStart, functionStart, functionEnd, lineCount);
        const endLine = clampLine(block?.endLine, Math.min(startLine + 5, functionEnd), startLine, functionEnd, lineCount);
        const label = String(block?.label || "关键逻辑").slice(0, 18);
        return {
          id: String(block?.id || `block-${fn.id}-${index}`),
          startLine,
          endLine,
          label,
        };
      }).filter((block) => !isLowValueReturnBlock(block, source?.lines || [])),
    };
  }).filter(Boolean).filter((item) => item.functionRange.startLine <= item.functionRange.endLine);

  function clampLine(value, fallback, min, max, lineCount) {
    const line = Number(value) || fallback;
    return Math.max(min, Math.min(max, Math.min(line, lineCount || max)));
  }
}

function sanitizeScenarioFlow(rawFlow, functionStart, functionEnd, lineCount, clampLine) {
  if (!rawFlow || typeof rawFlow !== "object") {
    return null;
  }
  const steps = (Array.isArray(rawFlow.steps) ? rawFlow.steps : []).slice(0, 8).map((step, index) => {
    const startLine = clampLine(step?.startLine, functionStart, functionStart, functionEnd, lineCount);
    const endLine = clampLine(step?.endLine, Math.min(startLine + 5, functionEnd), startLine, functionEnd, lineCount);
    return {
      title: String(step?.title || `步骤 ${index + 1}`).slice(0, 24),
      startLine,
      endLine,
      takes: strings(step?.takes).slice(0, 5),
      does: String(step?.does || "").slice(0, 180),
      produces: String(step?.produces || "").slice(0, 140),
      next: String(step?.next || "").slice(0, 140),
    };
  }).filter((step) => step.startLine <= step.endLine && (step.does || step.produces || step.takes.length));

  const scenario = String(rawFlow.scenario || "").slice(0, 180);
  const summary = String(rawFlow.summary || "").slice(0, 220);
  const output = String(rawFlow.output || "").slice(0, 160);
  if (!scenario && !summary && !steps.length && !output) {
    return null;
  }
  return { scenario, summary, steps, output };
}

function isLowValueReturnBlock(block, lines) {
  const label = String(block?.label || "").trim().toLowerCase();
  if (/^(返回|返回结果|return|return result)$/.test(label)) {
    return true;
  }
  const blockText = lines.slice((block.startLine || 1) - 1, block.endLine || block.startLine).join("\n").trim();
  return /^return\b[\s\S]*$/.test(blockText) && blockText.split(/\r?\n/).length <= 2;
}

function sanitizeVariableFlows(rawFlows, legacyVariables = {}) {
  const flows = (Array.isArray(rawFlows) ? rawFlows : []).map((flow) => ({
    name: String(flow?.name || "").slice(0, 32),
    label: String(flow?.label || flow?.meaning || "").slice(0, 80),
    before: String(flow?.before || flow?.from || "").slice(0, 140),
    sources: sanitizeFlowSources(flow?.sources).slice(0, 4),
    after: String(flow?.after || flow?.to || "").slice(0, 180),
    effect: String(flow?.effect || flow?.why || "").slice(0, 180),
  })).filter((flow) => flow.name && (flow.label || flow.before || flow.after || flow.effect));

  if (flows.length) {
    return flows.slice(0, 3);
  }

  const inputs = strings(legacyVariables?.inputs).slice(0, 3);
  const outputs = strings(legacyVariables?.outputs).slice(0, 2);
  const changes = strings(legacyVariables?.changes).slice(0, 2);
  return outputs.map((output) => ({
    name: extractVariableName(output) || output,
    label: "输出数据",
    before: inputs.length ? `来自 ${inputs.join("、")}` : "函数内部构造",
    sources: inputs.map((input) => ({ name: input, detail: "" })),
    after: output,
    effect: changes.join("；") || String(legacyVariables?.note || "").slice(0, 120),
  })).slice(0, 3);
}

function sanitizeFlowSources(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((source) => {
    if (typeof source === "string") {
      return { name: source.slice(0, 32), detail: "" };
    }
    return {
      name: String(source?.name || "").slice(0, 32),
      detail: String(source?.detail || source?.label || source?.meaning || "").slice(0, 120),
      value: String(source?.value || source?.current || "").slice(0, 100),
      use: String(source?.use || source?.effect || "").slice(0, 100),
    };
  }).filter((source) => source.name);
}

function extractVariableName(value) {
  const text = typeof value === "object" && value ? String(value.name || "") : String(value || "").trim();
  const match = text.match(/[A-Za-z_][A-Za-z0-9_]*/);
  return match ? match[0] : "";
}

function isValuableVariableName(name) {
  return name && !new Set(["self", "e", "i", "j", "x", "y", "item", "items", "result", "results", "value", "values", "data"]).has(name);
}

function strings(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hydrateFunctionLabels(functions, treeNotes, annotations) {
  const keyIds = new Set(annotations.map((item) => item.functionId));
  return functions.map((fn) => ({
    ...fn,
    isKey: keyIds.has(fn.id),
    label: normalizeFunctionLabel(fn.label, inferFunctionKeyword(fn.fullName), 10),
    importance: keyIds.has(fn.id) ? "core" : fn.importance,
  }));
}

async function callChatCompletion({ apiKey, baseUrl, model, systemPrompt, userPrompt, temperature = 0.1 }) {
  const endpoint = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);

  try {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          temperature,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
    } catch (error) {
      throw new Error(`LLM network request failed: ${endpoint} (${error.cause?.message || error.message})`);
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(text || "LLM returned non-JSON response.");
    }

    if (!response.ok) {
      throw new Error(data?.error?.message || `LLM HTTP ${response.status}`);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM returned an empty response.");
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object in LLM response.");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(start, index + 1));
      }
    }
  }
  throw new Error("Incomplete JSON object in LLM response.");
}

async function callJsonModel(params) {
  const audit = createModelAuditEntry(params);
  const raw = await callChatCompletion(params);
  audit.responseText = raw;
  audit.responseChars = raw.length;
  try {
    const parsed = extractJson(raw);
    audit.parsedJson = parsed;
    audit.status = "parsed";
    audit.completedAt = new Date().toISOString();
    return parsed;
  } catch (error) {
    audit.parseError = error.message;
    audit.status = "repairing";
    const repaired = await callChatCompletion({
      ...params,
      temperature: 0,
      userPrompt: `Repair this into a single valid JSON object. Output JSON only.\n\n${raw}`,
    });
    audit.repairResponseText = repaired;
    audit.repairResponseChars = repaired.length;
    const parsed = extractJson(repaired);
    audit.parsedJson = parsed;
    audit.status = "repaired";
    audit.completedAt = new Date().toISOString();
    return parsed;
  }
}

function createModelAuditEntry(params) {
  const entry = {
    id: `llm-${lastModelLogs.length + 1}`,
    stage: params.callName || "llm",
    createdAt: new Date().toISOString(),
    baseUrl: params.baseUrl || DEFAULT_BASE_URL,
    model: params.model || DEFAULT_MODEL,
    temperature: params.temperature ?? 0.1,
    messages: [
      { role: "system", content: params.systemPrompt || "" },
      { role: "user", content: params.userPrompt || "" },
    ],
    systemPrompt: params.systemPrompt || "",
    userPrompt: params.userPrompt || "",
    requestChars: {
      system: (params.systemPrompt || "").length,
      user: (params.userPrompt || "").length,
    },
    status: "calling",
  };
  lastModelLogs.push(entry);
  return entry;
}

function buildSemanticsPrompt({ context, summary, supportFiles, functions }) {
  const candidates = {
    repo: context.repo,
    readme: clip(context.readme, 5000),
    supportFiles: supportFiles.map((file) => ({ path: file.path, content: clip(file.content, 1400) })),
    directories: summary.directories.slice(0, 80),
    files: summary.files.slice(0, 120).map((file) => ({ path: file.path, score: file.score, size: file.size })),
    functions: functions.slice(0, 220).map((fn) => ({
      id: fn.id,
      file: fn.file,
      fullName: fn.fullName,
      startLine: fn.startLine,
      endLine: fn.endLine,
      calls: fn.calls.slice(0, 12),
      callSites: (fn.callSites || []).slice(0, 2),
    })),
  };

  return `
你在帮助构建 HKUDS/nanobot 的 agent 源码学习页面。请基于真实目录、README、函数索引、calls、callSites 输出结构化 JSON。

产品目标：不是给用户一份总结，而是让用户沿着源码学习“这个 agent 在什么场景下，拿什么数据，如何处理，最后交给谁”。

三层必须严格区分：
- Prompt：研究 system prompt、身份、规则、格式、工具说明如何让 LLM 明白任务。只选“写给 LLM 的指令/规则/格式/能力说明”相关函数。
- Context：研究 history、memory、文件、工具结果、压缩策略如何把正确少量信息暴露给 LLM。只选“选择/整理/注入信息给 LLM 看”相关函数。
- Harness：研究 AgentLoop、消息总线、模型请求、tools/MCP、状态、兜底如何驱动 agent。只选“程序如何调度模型、工具、状态”的函数。

严格要求：
1. 只引用输入中存在的 path 和 function id。
2. 先生成 learningScenarios，再由 learningScenarios 派生 flowTabs；不要直接堆函数。
3. 每个 learning scenario 必须回答：用户在学什么问题、入口函数是谁、拿了哪些数据、输出是什么、为什么重要。
4. Prompt 和 Context 不能混：build_system_prompt 里“写规则/身份”属于 Prompt；读取 history/memory/files 并控制注入内容属于 Context。
5. 文件夹、文件、函数说明都用关键词或极短词组；低置信度就留空，不要输出文件名/函数名，也不要输出“循环、历史、执行步骤、消息处理”这类废标签。
6. 保留这些英文术语，不要硬翻译：agent、skills、memory、prompt、system prompt、tools、MCP、LLM、provider、context、hook、channel、session。
7. flow 卡片标题要极简；函数列表只引用 function id；target 优先使用 callSites，没有 callSites 才用 definition。
8. 不要编造不存在的函数。

输出 JSON 形状：
{
  "project": { "summary": "一句话定位" },
  "treeNotes": [
    { "path": "真实路径", "type": "directory|file", "label": "关键词或空字符串", "importance": "core|normal" }
  ],
  "functionLabels": [
    { "functionId": "真实函数 id", "label": "关键词或空字符串", "importance": "core|normal" }
  ],
  "learningScenarios": [
    {
      "id": "短 id",
      "layer": "prompt|context|harness",
      "title": "场景标题",
      "userQuestion": "用户通过这个场景想搞懂什么",
      "entryFunctionIds": ["真实函数 id"],
      "dataInputs": ["这个场景会拿到的数据"],
      "output": "这个场景最终产出什么",
      "whyImportant": "为什么这是学习 agent 构建的关键点"
    }
  ],
  "flowTabs": [
    {
      "id": "prompt|context|harness",
      "label": "Prompt|Context|Harness",
      "cards": [
        {
          "id": "短 id",
          "title": "极简标题",
          "summary": "极短步骤解释",
          "functions": [
            {
              "functionId": "真实函数 id",
              "displayName": "函数全称",
              "target": { "file": "真实路径", "startLine": 1, "endLine": 1, "kind": "callSite|definition" }
            }
          ]
        }
      ]
    }
  ]
}

输入材料：
${JSON.stringify(candidates, null, 2)}
  `.trim();
}

function buildAnnotationPrompt({ context, treeNotes, flowTabs, learningScenarios, keyFunctions, sources }) {
  const sourceByPath = new Map(sources.map((source) => [source.path, source]));
  const snippets = keyFunctions.map((fn) => {
    const source = sourceByPath.get(fn.file);
    const lines = source ? source.lines.slice(fn.startLine - 1, fn.endLine) : [];
    return {
      functionId: fn.id,
      file: fn.file,
      fullName: fn.fullName,
      label: fn.label,
      startLine: fn.startLine,
      endLine: fn.endLine,
      calls: fn.calls.slice(0, 20),
      learningScenarios: scenariosForFunction(learningScenarios, fn.id),
      code: lines.map((line, index) => `${String(fn.startLine + index).padStart(4, " ")} | ${line}`).join("\n"),
    };
  });

  return `
你在为 nanobot 源码学习页面生成关键函数注释。请只基于给定源码和 learning scenarios 输出 JSON。

严格要求：
1. 每个 key function 生成一个 annotation。
2. functionRange 必须在函数真实 startLine/endLine 内。
3. floatingPanel.scenarioFlow 是核心；不要再围绕“变量列表”讲解，要围绕“场景中的数据处理步骤”讲。
4. scenario 必须回答“什么场景下执行这段函数”；summary 必须回答“这段函数在该场景里负责什么”。
5. steps 必须对应真实源码行，每步回答：拿什么数据 takes、如何处理 does、产出什么 produces、交给谁 next。
6. steps 不要包含普通 return；只有 return 同时承担协议封装、格式转换、错误兜底时，才把它合并进更大的步骤。
7. 禁止输出这些需要猜的短语：添加身份、添加文件、消费消息、处理优先级、路由到队列、执行步骤、处理数据、读取数据。
8. 如果源码已有英文 docstring 或注释，请吸收其真实含义，用清楚中文重写。
9. 保留这些英文术语，不要硬翻译：agent、skills、memory、prompt、system prompt、tools、MCP、LLM、provider、context、hook、channel、session。
10. highlightVariables 只放 steps 的 takes/produces 中真正值得高亮的变量名，最多 4 个。
11. 不要输出 markdown，不要解释 JSON 之外的内容。

输出 JSON 形状：
{
  "keyAnnotations": [
    {
      "functionId": "真实函数 id",
      "file": "真实路径",
      "functionRange": { "startLine": 1, "endLine": 10 },
      "floatingPanel": {
        "scenarioFlow": {
          "scenario": "什么场景下执行这段函数",
          "summary": "这段函数在该场景里的职责",
          "steps": [
            {
              "title": "步骤名",
              "startLine": 1,
              "endLine": 3,
              "takes": ["输入数据"],
              "does": "这一步如何组织、筛选、转换或传递数据",
              "produces": "这一步产出什么",
              "next": "产出交给谁/下一步做什么"
            }
          ],
          "output": "最终输出"
        }
      },
      "highlightVariables": ["最多 4 个变量名"]
    }
  ]
}

项目摘要：
${clip(context.readme, 2500)}

目录语义：
${JSON.stringify(treeNotes.slice(0, 100), null, 2)}

流程卡片：
${JSON.stringify(flowTabs, null, 2)}

学习场景：
${JSON.stringify(learningScenarios, null, 2)}

关键函数源码：
${JSON.stringify(snippets, null, 2)}
  `.trim();
}

function mergeSemantics(localNotes, localFlows, functions, raw) {
  const validPaths = new Set(localNotes.map((note) => note.path));
  const rawTreeNotes = (Array.isArray(raw?.treeNotes) ? raw.treeNotes : [])
    .filter((note) => validPaths.has(String(note?.path || "")))
    .slice(0, 180)
    .map((note) => ({
      path: String(note.path),
      type: note.type === "directory" ? "directory" : "file",
      label: normalizeShortLabel(note.label, inferPathKeyword(note.path), 10),
      importance: note.importance === "core" ? "core" : "normal",
    }));
  const rawNoteByPath = new Map(rawTreeNotes.map((note) => [`${note.type}:${note.path}`, note]));
  const treeNotes = localNotes.map((note) => rawNoteByPath.get(`${note.type}:${note.path}`) || note);

  const functionById = new Map(functions.map((fn) => [fn.id, fn]));
  for (const item of Array.isArray(raw?.functionLabels) ? raw.functionLabels : []) {
    const fn = functionById.get(String(item?.functionId || ""));
    if (fn) {
      fn.label = normalizeFunctionLabel(item.label, inferFunctionKeyword(fn.fullName), 10);
      fn.importance = item.importance === "core" ? "core" : fn.importance;
    }
  }
  const sanitizedFlowTabs = sanitizeFlowTabs(raw?.flowTabs, functions);
  const learningScenarios = sanitizeLearningScenarios(raw?.learningScenarios, functions);

  return {
    projectSummary: String(raw?.project?.summary || "nanobot agent 源码学习").slice(0, 140),
    treeNotes,
    learningScenarios,
    flowTabs: sanitizedFlowTabs.some((tab) => tab.id !== "overview" && tab.cards.length)
      ? sanitizedFlowTabs
      : localFlows,
  };
}

async function analyzeNanobot(input) {
  const logs = [];
  lastRunLogs = logs;
  lastModelLogs = [];
  const startedAt = Date.now();
  const source = input.source === "local" ? "local" : "github";
  logStep(logs, "start", "Start source analysis.", {
    source,
    repo: source === "local" ? input.localPath : `https://github.com/${NANOBOT_OWNER}/${NANOBOT_REPO}`,
    llmEnabled: Boolean(input.apiKey),
    baseUrl: input.baseUrl || DEFAULT_BASE_URL,
    model: input.model || DEFAULT_MODEL,
  });
  const context = source === "local" ? await readLocalContext(input.localPath) : await fetchNanobotContext();
  logStep(logs, source, "Loaded repository facts, README, and tree.", {
    defaultBranch: context.repo.defaultBranch,
    treeItems: context.tree.length,
    treeTruncated: context.truncated,
  });

  const summary = summarizeTree(context.tree);
  const supportFiles = await fetchSupportFiles(context, summary.files);
  logStep(logs, "source", "Fetched support files.", {
    count: supportFiles.length,
    files: supportFiles.map((file) => file.path),
  });

  const sources = await fetchPythonSources(context, summary.files);
  const sourceByPath = new Map(sources.map((source) => [source.path, source]));
  const functions = buildFunctionIndex(sources);
  logStep(logs, "index", "Built Python source index.", {
    pythonFiles: sources.length,
    functions: functions.length,
  });

  const localNotes = localTreeNotes(summary);
  const localFlows = localFlowTabs(functions);
  const localScenarios = localLearningScenarios(localFlows);
  let projectSummary = `${context.repo.name} agent 源码学习`;
  let treeNotes = localNotes;
  let flowTabs = localFlows;
  let learningScenarios = localScenarios;
  const llmEnabled = Boolean(input.apiKey);

  if (llmEnabled) {
    try {
      logStep(logs, "llm", "Calling LLM for tree semantics and flow cards.", {
        baseUrl: input.baseUrl || DEFAULT_BASE_URL,
        model: input.model || DEFAULT_MODEL,
      });
      const semanticRaw = await callJsonModel({
        callName: "semantics",
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        model: input.model,
        systemPrompt: "你是一个 agent 源码学习产品的数据标注器。你只输出合法 JSON。",
        userPrompt: buildSemanticsPrompt({ context, summary, supportFiles, functions }),
      });
      const merged = mergeSemantics(localNotes, localFlows, functions, semanticRaw);
      projectSummary = merged.projectSummary;
      treeNotes = merged.treeNotes;
      flowTabs = merged.flowTabs;
      learningScenarios = merged.learningScenarios.length ? merged.learningScenarios : localLearningScenarios(flowTabs);
      logStep(logs, "llm", "LLM generated tree notes and flow cards.", {
        treeNotes: treeNotes.length,
        scenarios: learningScenarios.length,
        tabs: flowTabs.length,
      });
    } catch (error) {
      logStep(logs, "fallback", "LLM semantic step failed; used local fallback.", {
        error: error.message,
      });
    }
  } else {
    logStep(logs, "fallback", "No API key provided; used local semantic fallback.", {});
  }

  const keyIds = flowFunctionIds(flowTabs);
  const keyFunctions = functions.filter((fn) => keyIds.has(fn.id)).slice(0, 18);
  let keyAnnotations = localAnnotations(functions, flowTabs);

  if (llmEnabled && keyFunctions.length) {
    try {
      logStep(logs, "llm", "Calling LLM for key function annotations.", {
        keyFunctions: keyFunctions.length,
        baseUrl: input.baseUrl || DEFAULT_BASE_URL,
        model: input.model || DEFAULT_MODEL,
      });
      const annotationRaw = await callJsonModel({
        callName: "annotations",
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        model: input.model,
        systemPrompt: "你是一个源码注释结构化标注器。你只输出合法 JSON。",
        userPrompt: buildAnnotationPrompt({ context, treeNotes, flowTabs, learningScenarios, keyFunctions, sources }),
      });
      const annotations = sanitizeAnnotations(annotationRaw?.keyAnnotations, functions, sources);
      if (annotations.length) {
        keyAnnotations = annotations;
      }
      logStep(logs, "llm", "LLM generated key annotations.", {
        annotations: keyAnnotations.length,
      });
    } catch (error) {
      logStep(logs, "fallback", "LLM annotation step failed; used local fallback.", {
        error: error.message,
      });
    }
  }

  const hydratedFunctions = hydrateFunctionLabels(functions, treeNotes, keyAnnotations);
  const files = summary.files.slice(0, 260).map((file) => ({
    ...file,
    label: treeNotes.find((note) => note.path === file.path)?.label || inferPathKeyword(file.path),
    content: sourceByPath.get(file.path)?.content || null,
    lineCount: sourceByPath.get(file.path)?.lines.length || null,
  }));

  const result = {
    project: {
      name: context.repo.name,
      repo: context.repo.fullName,
      url: context.repo.url,
      defaultBranch: context.repo.defaultBranch,
      description: context.repo.description,
      summary: projectSummary,
      readme: clip(context.readme, 4000),
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      treeTruncated: context.truncated,
    },
    treeNotes,
    files,
    directories: summary.directories.slice(0, 180),
    functions: hydratedFunctions,
    keyAnnotations,
    flowTabs,
    learningScenarios,
    logs,
  };

  try {
    const cachePath = await writeAnalysisCache(input, result, lastModelLogs);
    logStep(logs, "cache", "Saved analysis result to disk cache.", {
      cachePath,
    });
  } catch (error) {
    logStep(logs, "cache", "Failed to save analysis cache.", {
      error: error.message,
    });
  }

  return result;
}

function logStep(logs, stage, message, meta = {}) {
  const now = new Date();
  const localAt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now).replace(/\//g, "-");
  logs.push({
    localAt,
    timezone: "Asia/Shanghai",
    at: now.toISOString(),
    stage,
    message,
    meta,
  });
  lastRunLogs = logs;
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = requestUrl;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        version: "v2-nanobot",
        defaults: {
          baseUrl: DEFAULT_BASE_URL,
          model: DEFAULT_MODEL,
          repo: `https://github.com/${NANOBOT_OWNER}/${NANOBOT_REPO}`,
        },
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/v2/logs") {
      sendJson(res, 200, {
        logs: lastRunLogs,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/v2/model-logs") {
      sendJson(res, 200, {
        calls: lastModelLogs,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/v2/history") {
      sendJson(res, 200, {
        history: await listAnalysisHistory(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/v2/history/load") {
      const payload = await readHistoryById(requestUrl.searchParams.get("id"));
      if (!payload?.result) {
        sendJson(res, 404, { error: "History item not found." });
        return;
      }
      const result = structuredClone(payload.result);
      const logs = Array.isArray(result.logs) ? result.logs : [];
      logStep(logs, "history", "Loaded analysis result from history.", {
        id: payload.cacheId,
        savedAt: payload.savedAt,
        schema: payload.descriptor?.schema,
        model: payload.descriptor?.model,
      });
      result.logs = logs;
      result.project = {
        ...result.project,
        loadedFromHistory: true,
        historyId: payload.cacheId,
        historySavedAt: payload.savedAt,
      };
      lastRunLogs = logs;
      lastModelLogs = Array.isArray(payload.modelLogs) ? payload.modelLogs : [];
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/v2/analyze") {
      const body = await readJsonBody(req);
      const result = await analyzeNanobot({
        apiKey: String(body.apiKey || "").trim(),
        baseUrl: String(body.baseUrl || DEFAULT_BASE_URL).trim(),
        model: String(body.model || DEFAULT_MODEL).trim(),
        source: body.source === "local" ? "local" : "github",
        localPath: String(body.localPath || "").trim(),
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && pathname === "/api/v2/file") {
      const filePath = normalizePath(requestUrl.searchParams.get("path") || "");
      if (!filePath || isExcluded(filePath) || !isTextPath(filePath)) {
        sendJson(res, 400, { error: "Invalid file path." });
        return;
      }
      const localPath = requestUrl.searchParams.get("localPath");
      const context = localPath ? await readLocalContext(localPath) : await fetchNanobotContext();
      const content = await fetchRepoFile(context, filePath);
      sendJson(res, 200, {
        path: filePath,
        content,
        lines: content.split(/\r?\n/).length,
      });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res, pathname);
      return;
    }

    sendText(res, 405, "Method not allowed");
  } catch (error) {
    sendJson(res, 500, {
      error: error?.message || "Unknown server error.",
      logs: lastRunLogs,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Nanobot Source Learning Page running at http://${HOST}:${PORT}`);
});
