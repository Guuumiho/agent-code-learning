const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const HOST = "127.0.0.1";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3939;
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.join(__dirname, ".cache", "source-atlas");
const CACHE_SCHEMA_VERSION = "v2-mvp-cache-10";
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

function agentJourneyFunctionIds(agentJourneys) {
  const ids = new Set();
  for (const journey of agentJourneys || []) {
    for (const step of journey.steps || []) {
      for (const id of step.functionIds || []) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function localAgentJourneys(functions) {
  const find = (patterns, limit = 3) => functions
    .map((fn) => {
      const haystack = `${fn.file}/${fn.fullName}`.toLowerCase();
      const score = patterns.reduce((sum, pattern) => sum + (pattern.test(haystack) ? 10 : 0), 0)
        + (fn.file.startsWith("nanobot/") ? 2 : 0)
        + (fn.callSites?.length ? 1 : 0)
        - (path.basename(fn.file).toLowerCase() === "__init__.py" ? 100 : 0);
      return { fn, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.fn.startLine - b.fn.startLine)
    .slice(0, limit)
    .map((item) => item.fn.id);

  const makeStep = (id, title, layer, explain, functionIds) => ({
    id,
    title,
    layer,
    explain,
    functionIds,
  });
  const makeJourney = (id, title, question, mentalModel, steps) => ({
    id,
    title,
    question,
    mentalModel,
    source: "local-fallback",
    steps,
  });

  return [
    makeJourney(
      "simple-qa",
      "简单问答",
      "用户发来一句话后，agent 如何组织上下文并得到 LLM 回复？",
      "消息先进入统一 agent loop，再拼出 system prompt、history、memory、skills 和用户输入，交给 LLM；如果模型没有要求调用 tools，就把文本回复发回用户。",
      [
        makeStep("receive-message", "接收用户消息", "harness", "不同入口来的消息先进入统一消息通道，后面的 agent loop 不需要关心它来自 CLI、API 还是聊天平台。", find([/bus|channel|message|consume|inbound/i], 3)),
        makeStep("build-context", "构建上下文", "context", "把用户输入、history、memory、skills 等材料整理成 LLM 能读的 messages。", find([/contextbuilder.*build|build_messages|build_system_prompt|memory|skills/i], 4)),
        makeStep("call-llm", "请求 LLM", "harness", "程序把整理好的 messages 和模型参数交给 provider，等待模型返回文本或 tool call。", find([/_request_model|provider|completion|chat|llm|model/i], 3)),
        makeStep("final-reply", "输出回复", "harness", "如果模型没有要求调用工具，agent 把最终文本保存并返回给用户。", find([/final|append_final|save_turn|stream/i], 3)),
      ],
    ),
    makeJourney(
      "context-assembly",
      "上下文",
      "agent 如何决定让 LLM 看到哪些信息，并把信息控制在正确、少量、可用的范围内？",
      "context 不是把所有东西塞给模型，而是从用户输入、history、memory、文件、检索结果和 tool result 中挑出当前需要的材料，组织成 messages/system prompt。",
      [
        makeStep("collect-context", "收集可见信息", "context", "程序从用户消息、history、memory、文件上下文、retrieval result 和 tool result 中收集候选材料。", find([/history|memory|context|retrieval|file|tool_result/i], 5)),
        makeStep("shape-messages", "组织 messages", "context", "候选材料会被整理成 LLM 能理解的 system/user/assistant/tool messages，而不是原始程序对象。", find([/build_messages|to_blocks|message|append.*tool|contextbuilder/i], 5)),
        makeStep("control-budget", "控制信息量", "context", "当材料太多时，agent 会压缩、截断或清理一部分内容，优先保留当前任务最有用的信息。", find([/compact|compress|budget|truncate|snip|context_window/i], 5)),
        makeStep("inject-tool-result", "注入工具结果", "context", "tool result 会被放回 messages，让下一轮 LLM 能基于真实执行结果继续推理。", find([/tool_result|add_tool_result|normalize_tool_result|backfill/i], 5)),
      ],
    ),
    makeJourney(
      "tool-calling",
      "工具调用",
      "LLM 为什么会调用工具，程序如何执行工具并把结果交还给模型？",
      "工具 schema 先暴露给 LLM；模型返回 tool call 后，程序执行对应 tool，把 tool result 追加进 messages，再让 LLM 基于结果继续回答。",
      [
        makeStep("expose-tools", "暴露 tools", "prompt", "程序把可用 tools 和参数格式交给模型，让模型知道什么时候能请求外部能力。", find([/tool.*schema|registry|tools|mcp/i], 4)),
        makeStep("detect-tool-call", "识别 tool call", "harness", "模型响应里如果包含 tool call，agent loop 不直接结束，而是进入工具执行分支。", find([/should_execute_tools|tool_calls|run$/i], 4)),
        makeStep("execute-tools", "执行 tools/MCP", "harness", "程序根据模型给出的 tool 名称和参数调用本地 tool 或 MCP tool。", find([/_execute_tools|_run_tool|mcp|tool/i], 4)),
        makeStep("feed-result-back", "回填工具结果", "context", "tool result 被包装成 tool message 追加回上下文，下一轮 LLM 才能基于结果继续推理。", find([/tool_result|normalize_tool_result|messages.*append|backfill/i], 4)),
      ],
    ),
    makeJourney(
      "mcp-calling",
      "MCP 调用",
      "外部 MCP tool 如何被 agent 当成可调用能力使用？",
      "MCP server 暴露 tool schema，agent 把它们注册成统一 tools；模型请求 tool call 后，程序通过 MCP client 执行并拿回结果。",
      [
        makeStep("connect-mcp", "连接 MCP server", "harness", "程序先连接 MCP server，拿到外部工具列表和 schema。", find([/mcp|connect|server/i], 4)),
        makeStep("register-mcp-tools", "注册 MCP tools", "harness", "MCP tools 被转成 agent 内部统一的 tool 表示，后续模型不用关心工具来自本地还是 MCP。", find([/mcp|registry|tool/i], 4)),
        makeStep("execute-mcp-tool", "执行 MCP tool", "harness", "当模型请求某个 MCP tool，程序把参数发给 MCP server，再把执行结果包装回 tool result。", find([/mcp|_run_tool|execute/i], 4)),
      ],
    ),
    makeJourney(
      "memory-system",
      "记忆系统",
      "短期 history 和长期 memory 如何被读取、写入，并在下一轮任务中再次生效？",
      "memory 不是 LLM 自己保存的脑子，而是程序维护的外部状态；每轮请求前读取、必要时注入，请求后再把新事实或历史写回去。",
      [
        makeStep("read-memory", "读取 memory/history", "context", "agent 在请求 LLM 前读取短期 history 和长期 memory，准备把相关事实暴露给模型。", find([/read.*memory|history|get_memory|get_history|conversation/i], 5)),
        makeStep("inject-memory", "注入当前请求", "context", "memory/history 会被转成 prompt 片段或 messages，让 LLM 像是记得之前发生过什么。", find([/build_system_prompt|build_messages|get_memory_context|memory/i], 5)),
        makeStep("write-memory", "写回新信息", "harness", "当本轮对话产生新的事实或状态时，程序会把它保存进 memory/history，供后续任务使用。", find([/write.*memory|save_turn|append.*history|persist/i], 5)),
      ],
    ),
    makeJourney(
      "skills-loading",
      "skills 系统",
      "skills 如何变成 LLM 当前能使用的任务知识？",
      "skills 不是模型自动拥有的能力，程序会挑出 always skills 或相关 skills，把说明文本拼进 system prompt/context。",
      [
        makeStep("select-skills", "选择 skills", "context", "程序先判断哪些 skills 当前应该暴露给 LLM，例如 always skills。", find([/always.*skills?|get_always_skills|skill/i], 4)),
        makeStep("load-skills", "加载 skills 内容", "context", "被选中的 skills 会被读取成文本说明，作为当前任务可用知识。", find([/load.*skills?|skills.*context/i], 4)),
        makeStep("inject-skills", "注入 prompt/context", "prompt", "skills 内容或摘要被拼入 system prompt/context，让 LLM 知道有哪些额外能力。", find([/skills.*summary|build_system_prompt|render_template/i], 4)),
      ],
    ),
    makeJourney(
      "state-scheduling",
      "状态调度",
      "agent 如何在多轮任务里记住自己跑到哪一步，并调度消息、session、subagent 或定时任务？",
      "agent 不只是一次函数调用；它需要维护 run/session/turn/tool 状态，用 loop 和 message bus 驱动下一步，并在需要时派生 subagent 或后台任务。",
      [
        makeStep("agent-loop", "AgentLoop 推进任务", "harness", "agent loop 持续接收事件、判断下一步动作，并把任务从输入推进到模型请求、工具执行或最终回复。", find([/agentloop|loop|run$|process|step/i], 5)),
        makeStep("message-bus", "消息总线分发", "harness", "message bus 把不同来源的消息统一排队和分发，让核心 agent 不被具体入口绑死。", find([/bus|inbound|outbound|channel|message/i], 5)),
        makeStep("session-state", "更新 session 状态", "harness", "程序记录当前 session、run、turn、pending tool 等状态，保证下一步知道接着哪里运行。", find([/session|state|pending|checkpoint|persist|runtime/i], 5)),
        makeStep("subagent-schedule", "调度子任务", "harness", "当任务需要拆分或后台运行时，agent 可以派生 subagent 或 schedule，让主流程保持可控。", find([/subagent|schedule|background|task|queue/i], 5)),
      ],
    ),
    makeJourney(
      "fallback",
      "异常兜底",
      "模型空回复、超长、工具失败时，agent 如何避免直接崩掉？",
      "agent loop 会识别异常状态，尝试重试、恢复、补齐工具结果或返回可理解的错误。",
      [
        makeStep("retry-empty", "空回复重试", "harness", "模型返回空内容时，程序不会立刻结束，而是尝试重试或请求最终化。", find([/empty|finalization|retry/i], 4)),
        makeStep("recover-length", "超长恢复", "harness", "模型因为长度限制中断时，程序会继续请求，把输出接起来。", find([/length|recovery|continue/i], 4)),
        makeStep("repair-tools", "修复工具结果", "context", "缺失或孤立的 tool result 会被清理或补齐，防止下一轮 LLM 输入格式坏掉。", find([/orphan|backfill|tool_result|repair/i], 4)),
      ],
    ),
  ];
}

function localAnnotations(functions, flowTabs, agentJourneys = []) {
  const ids = new Set([...flowFunctionIds(flowTabs), ...agentJourneyFunctionIds(agentJourneys)]);
  return functions
    .filter((fn) => ids.has(fn.id))
    .slice(0, 28)
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
            journey: "本地规则推断",
            currentStep: "等待 LLM 补充机制步骤",
            scenario: "本地索引已定位这个关键函数；需要 LLM 补充它属于哪条 agent 旅程。",
            summary: "本地只能定位源码证据，完整机制讲解需要 LLM 根据 journey 补充。",
            steps: [],
            output: "等待 LLM 补充 agent 机制讲解。",
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

function sanitizeAgentJourneys(rawJourneys, functions) {
  const functionIds = new Set(functions.map((fn) => fn.id));
  return (Array.isArray(rawJourneys) ? rawJourneys : []).slice(0, 8).map((raw, journeyIndex) => {
    const steps = (Array.isArray(raw?.steps) ? raw.steps : []).slice(0, 10).map((step, stepIndex) => {
      const ids = (Array.isArray(step?.functionIds) ? step.functionIds : [])
        .map(String)
        .filter((id) => functionIds.has(id))
        .slice(0, 6);
      return {
        id: String(step?.id || `step-${stepIndex}`).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48),
        title: String(step?.title || "机制步骤").slice(0, 24),
        layer: ["prompt", "context", "harness"].includes(String(step?.layer || "").toLowerCase())
          ? String(step.layer).toLowerCase()
          : "harness",
        explain: String(step?.explain || "").slice(0, 260),
        functionIds: ids,
      };
    }).filter((step) => step.explain || step.functionIds.length);
    if (!steps.length) {
      return null;
    }
    return {
      id: String(raw?.id || `journey-${journeyIndex}`).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48),
      title: String(raw?.title || "Agent 旅程").slice(0, 18),
      question: String(raw?.question || "").slice(0, 180),
      mentalModel: String(raw?.mentalModel || "").slice(0, 260),
      source: raw?.source === "local-fallback" ? "local-fallback" : "",
      steps,
    };
  }).filter(Boolean);
}

function mergeAgentJourneys(primary, fallback) {
  const order = [
    "simple-qa",
    "context-assembly",
    "tool-calling",
    "mcp-calling",
    "memory-system",
    "skills-loading",
    "state-scheduling",
    "fallback",
  ];
  const byKey = new Map();
  for (const journey of [...(fallback || []), ...(primary || [])]) {
    const key = canonicalJourneyKey(journey);
    if (key) {
      byKey.set(key, { ...journey, id: key });
    }
  }
  return order.map((key) => byKey.get(key)).filter(Boolean);
}

function canonicalJourneyKey(journey) {
  const id = String(journey?.id || "").toLowerCase();
  const title = String(journey?.title || "").toLowerCase();
  const text = `${id} ${title}`;
  if (/simple|qa|问答|聊天|回复/.test(text)) return "simple-qa";
  if (/context|上下文|history|retrieval|compression|装配/.test(text)) return "context-assembly";
  if (/tool-calling|工具调用|tool call/.test(text)) return "tool-calling";
  if (/mcp/.test(text)) return "mcp-calling";
  if (/memory|记忆/.test(text)) return "memory-system";
  if (/skills?|技能/.test(text)) return "skills-loading";
  if (/state|schedule|subagent|loop|bus|状态|调度|会话|消息总线/.test(text)) return "state-scheduling";
  if (/fallback|retry|异常|兜底|恢复|重试/.test(text)) return "fallback";
  return "";
}

function journeyScenarios(agentJourneys) {
  return (agentJourneys || []).flatMap((journey) => (journey.steps || []).map((step) => ({
    id: `${journey.id}-${step.id}`,
    layer: step.layer,
    title: step.title,
    userQuestion: journey.question,
    entryFunctionIds: step.functionIds || [],
    dataInputs: [],
    output: "",
    whyImportant: `${journey.title}：${step.explain}`,
  }))).filter((scenario) => scenario.entryFunctionIds.length);
}

function journeyStepsForFunction(agentJourneys, functionId) {
  return (agentJourneys || []).flatMap((journey) => (journey.steps || [])
    .filter((step) => (step.functionIds || []).includes(functionId))
    .map((step) => ({
      journeyId: journey.id,
      journeyTitle: journey.title,
      journeyQuestion: journey.question,
      mentalModel: journey.mentalModel,
      stepId: step.id,
      stepTitle: step.title,
      layer: step.layer,
      explain: step.explain,
    })));
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
  const journey = String(rawFlow.journey || "").slice(0, 80);
  const currentStep = String(rawFlow.currentStep || "").slice(0, 80);
  const summary = String(rawFlow.summary || "").slice(0, 220);
  const output = String(rawFlow.output || "").slice(0, 160);
  if (!journey && !currentStep && !scenario && !summary && !steps.length && !output) {
    return null;
  }
  return { journey, currentStep, scenario, summary, steps, output };
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

产品目标：帮助 agent 小白理解“agent 是怎样跑起来的”。源码只是证据，不要把右侧流程写成函数清单。

你必须优先生成 agentJourneys。必须尽量输出以下 8 类 journey；只有输入中完全找不到相关函数时才允许省略，并在 mentalModel 里说明“源码证据不足”：
1. 简单问答：用户消息进入 -> 统一消息格式 -> 构建上下文 -> 调用 LLM -> 输出回复。
2. 上下文：history、memory、file context、retrieval result、tool result、compression 如何进入 messages/system prompt。
3. 工具调用：暴露 tools -> LLM 产生 tool call -> 程序执行 tool/MCP -> tool result 回填 -> 再次请求 LLM。
4. MCP 调用：连接 MCP server -> 注册 MCP tools -> 执行 MCP tool -> 回填 MCP 结果。
5. 记忆系统：读取、注入、写回短期 history 和长期 memory。
6. skills 系统：读取 always skills/skills summary -> 注入 prompt/context。
7. 状态调度：AgentLoop、message bus、session/run state、state update、subagent、schedule 如何推动任务。
8. 异常兜底：空回复、超长、tool 失败、格式损坏如何恢复。

每个 journey step 只绑定少量关键函数作为源码证据。不要把实现细节暴露成主线；要先讲机制，再给函数入口。

step.layer 只作为小标签：
- prompt：写给 LLM 的身份、规则、格式、工具说明。
- context：选择、压缩、注入 LLM 应该看到的信息。
- harness：调度消息、模型、tools/MCP、状态、重试、输出。

严格要求：
1. 只引用输入中存在的 path 和 function id。
2. 先生成 agentJourneys；flowTabs 只作为旧 UI 兼容字段，可以从 journeys 粗略派生。
3. 不要把 Prompt / Context / Harness 当作 journey 名称；它们只能作为 step.layer 标签。
4. 第一个 journey 必须是“简单问答”，并且至少覆盖：消息进入、上下文构建、LLM 请求、回复处理。
5. 必须生成“上下文”，并尽量覆盖：history、memory、file context、retrieval result、tool result injection、compression、session context。
6. 必须生成“状态调度”，并尽量覆盖：agent loop、message bus、session state、run state、state update、subagent、schedule。
7. 如果仓库包含 memory、skills、MCP、fallback 相关函数，必须分别生成对应 journey；不要只输出“简单问答”和“工具调用”。
8. 文件夹、文件、函数说明都用关键词或极短词组；低置信度就留空，不要输出文件名/函数名，也不要输出“循环、历史、执行步骤、消息处理”这类废标签。
9. 保留这些英文术语，不要硬翻译：agent、skills、memory、prompt、system prompt、tools、MCP、LLM、provider、context、hook、channel、session。
10. journey step 的 explain 要给 agent 小白看懂，禁止“队列消费、执行步骤、添加身份、处理数据、路由队列”这类实现黑话。应该写“把工具结果塞回 messages，让 LLM 能继续基于真实结果推理”这种机制语言。
11. 不要编造不存在的函数。

输出 JSON 形状：
{
  "project": { "summary": "一句话定位" },
  "treeNotes": [
    { "path": "真实路径", "type": "directory|file", "label": "关键词或空字符串", "importance": "core|normal" }
  ],
  "functionLabels": [
    { "functionId": "真实函数 id", "label": "关键词或空字符串", "importance": "core|normal" }
  ],
  "agentJourneys": [
    {
      "id": "simple-qa",
      "title": "简单问答",
      "question": "用户发来一句话后，agent 如何组织上下文并得到 LLM 回复？",
      "mentalModel": "一句话心智模型",
      "steps": [
        {
          "id": "receive-message",
          "title": "接收用户消息",
          "layer": "prompt|context|harness",
          "explain": "面向 agent 小白的机制解释",
          "functionIds": ["真实函数 id"]
        }
      ]
    }
  ],
  "learningScenarios": [],
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

function buildAnnotationPrompt({ context, treeNotes, flowTabs, learningScenarios, agentJourneys, keyFunctions, sources }) {
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
      journeySteps: journeyStepsForFunction(agentJourneys, fn.id),
      code: lines.map((line, index) => `${String(fn.startLine + index).padStart(4, " ")} | ${line}`).join("\n"),
    };
  });

  return `
你在为 nanobot 源码学习页面生成关键函数注释。请只基于给定源码和 agent journeys 输出 JSON。

严格要求：
1. 每个 key function 生成一个 annotation。
2. functionRange 必须在函数真实 startLine/endLine 内。
3. floatingPanel.scenarioFlow 是核心；不要围绕变量列表讲解，要解释“这个函数在 agent 旅程的哪一步提供证据”。
4. scenario 必须写“所属旅程 + 当前机制步骤”；summary 必须屏蔽无关实现细节，说明这段代码在 agent 机制里承担什么角色。
5. steps 必须对应真实源码行，每步回答：这一步拿到什么 agent 数据 takes、如何把它变成下一阶段需要的形态 does、产出什么 produces、交给谁 next。
6. 如果函数属于“上下文”，重点解释：拿到哪些信息、为什么要给 LLM、如何控制信息量、最后变成 messages/system prompt/tool message 的哪一部分。
7. 如果函数属于“状态调度”，重点解释：谁触发这一步、哪个 state 被更新、下一步交给 agent loop/message bus/subagent/schedule 的哪个机制。
8. 如果函数属于“工具调用”或“MCP 调用”，重点解释：tool schema 如何暴露、tool call 如何执行、tool result 如何回填给下一轮 LLM。
9. steps 不要包含普通 return；只有 return 同时承担协议封装、格式转换、错误兜底时，才把它合并进更大的步骤。
10. 禁止输出这些需要猜的短语：添加身份、添加文件、消费消息、处理优先级、路由到队列、执行步骤、处理数据、读取数据。
11. 如果源码已有英文 docstring 或注释，请吸收其真实含义，用清楚中文重写。
12. 保留这些英文术语，不要硬翻译：agent、skills、memory、prompt、system prompt、tools、MCP、LLM、provider、context、hook、channel、session。
13. highlightVariables 保持空数组；UI 现在不再需要变量染色。
14. 不要输出 markdown，不要解释 JSON 之外的内容。

输出 JSON 形状：
{
  "keyAnnotations": [
    {
      "functionId": "真实函数 id",
      "file": "真实路径",
      "functionRange": { "startLine": 1, "endLine": 10 },
      "floatingPanel": {
        "scenarioFlow": {
          "journey": "所属旅程标题",
          "currentStep": "当前机制步骤",
          "scenario": "什么 agent 机制场景下执行这段函数",
          "summary": "屏蔽无关实现细节后，这段代码在 agent 机制里承担什么角色",
          "steps": [
            {
              "title": "步骤名",
              "startLine": 1,
              "endLine": 3,
              "takes": ["用户消息/history/memory/tools/其他 agent 数据"],
              "does": "这一步如何把 agent 数据变成下一阶段需要的形态",
              "produces": "这一步产出什么 agent 数据",
              "next": "交给 LLM/provider/tool executor/message bus/用户"
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

Agent 旅程：
${JSON.stringify(agentJourneys, null, 2)}

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
  const agentJourneys = sanitizeAgentJourneys(raw?.agentJourneys, functions);
  const localJourneys = localAgentJourneys(functions);

  return {
    projectSummary: String(raw?.project?.summary || "nanobot agent 源码学习").slice(0, 140),
    treeNotes,
    learningScenarios,
    agentJourneys: mergeAgentJourneys(agentJourneys, localJourneys),
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
  const localJourneys = localAgentJourneys(functions);
  const localScenarios = journeyScenarios(localJourneys);
  let projectSummary = `${context.repo.name} agent 源码学习`;
  let treeNotes = localNotes;
  let flowTabs = localFlows;
  let agentJourneys = localJourneys;
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
      agentJourneys = merged.agentJourneys.length ? merged.agentJourneys : localJourneys;
      learningScenarios = journeyScenarios(agentJourneys);
      logStep(logs, "llm", "LLM generated tree notes and flow cards.", {
        treeNotes: treeNotes.length,
        journeys: agentJourneys.length,
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

  const keyIds = new Set([...flowFunctionIds(flowTabs), ...agentJourneyFunctionIds(agentJourneys)]);
  const keyFunctions = functions.filter((fn) => keyIds.has(fn.id)).slice(0, 28);
  let keyAnnotations = localAnnotations(functions, flowTabs, agentJourneys);

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
        userPrompt: buildAnnotationPrompt({ context, treeNotes, flowTabs, learningScenarios, agentJourneys, keyFunctions, sources }),
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
    agentJourneys,
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
