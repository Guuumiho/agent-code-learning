const settingsForm = document.getElementById("settingsForm");
const analyzeGithubButton = document.getElementById("analyzeGithubButton");
const analyzeLocalButton = document.getElementById("analyzeLocalButton");
const apiKeyInput = document.getElementById("apiKeyInput");
const localPathInput = document.getElementById("localPathInput");
const baseUrlInput = document.getElementById("baseUrlInput");
const modelInput = document.getElementById("modelInput");
const forceAnalyzeInput = document.getElementById("forceAnalyzeInput");
const historySelect = document.getElementById("historySelect");
const loadHistoryButton = document.getElementById("loadHistoryButton");
const treeRoot = document.getElementById("treeRoot");
const treeMeta = document.getElementById("treeMeta");
const statusText = document.getElementById("statusText");
const currentFile = document.getElementById("currentFile");
const currentFileMeta = document.getElementById("currentFileMeta");
const flowTabsRoot = document.getElementById("flowTabs");
const flowContent = document.getElementById("flowContent");
const logContent = document.getElementById("logContent");
const editorRoot = document.getElementById("editorRoot");
const plainCodeFallback = document.getElementById("plainCodeFallback");
const floatingPanel = document.getElementById("floatingPanel");
const floatingTitle = document.getElementById("floatingTitle");
const floatingBody = document.getElementById("floatingBody");
const floatingDragHandle = document.getElementById("floatingDragHandle");
const floatingClose = document.getElementById("floatingClose");

const STORAGE_KEY = "nanobot-source-atlas-settings";
let appData = null;
let editor = null;
let monacoApi = null;
let currentPath = null;
let selectedFilePath = null;
let selectedFlowTab = "prompt";
let activeAnnotation = null;
let decorationIds = [];
let jumpDecorationIds = [];
let viewZoneIds = [];
let floatingPosition = null;
let dragState = null;
const fileContentCache = new Map();
const expandedDirs = new Set();
const expandedFiles = new Set();

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    localPath: localPathInput.value,
    baseUrl: baseUrlInput.value,
    model: modelInput.value,
    forceAnalyze: forceAnalyzeInput.checked,
  }));
}

function loadSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    apiKeyInput.value = "";
    localPathInput.value = settings.localPath || "";
    baseUrlInput.value = settings.baseUrl || "https://api.openai.com/v1";
    modelInput.value = settings.model || "gpt-4.1-mini";
    forceAnalyzeInput.checked = Boolean(settings.forceAnalyze);
  } catch {
    // Ignore broken local settings.
  }
}

function setStatus(message) {
  statusText.textContent = message;
}

function formatHistoryTime(value) {
  if (!value) return "未知时间";
  return new Date(value).toLocaleString();
}

async function loadHistoryList() {
  try {
    const response = await fetch("/api/v2/history");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取历史失败");
    const current = historySelect.value;
    const history = data.history || [];
    historySelect.innerHTML = `<option value="">${history.length ? `历史分析（${history.length}）` : "暂无历史"}</option>`;
    for (const item of history) {
      const option = document.createElement("option");
      option.value = item.id;
      const source = item.source === "local" ? "本地" : "GitHub";
      const llm = item.llmEnabled ? item.model : "无LLM";
      option.textContent = `${formatHistoryTime(item.savedAt)} · ${source} · ${item.projectName || item.target} · ${llm}`;
      option.title = `${item.target}\n${item.functions} functions · ${item.annotations} annotations · ${item.modelCalls} model calls`;
      historySelect.appendChild(option);
    }
    if (current && [...historySelect.options].some((option) => option.value === current)) {
      historySelect.value = current;
    }
    loadHistoryButton.disabled = history.length === 0;
  } catch (error) {
    console.warn(error);
    historySelect.innerHTML = "<option value=\"\">历史读取失败</option>";
    loadHistoryButton.disabled = true;
    setStatus(`历史读取失败：${error.message}`);
  }
}

async function loadSelectedHistory() {
  const id = historySelect.value;
  if (!id) {
    setStatus("请先选择一条历史分析。");
    return;
  }
  loadHistoryButton.disabled = true;
  setStatus("正在读取历史分析...");
  try {
    const response = await fetch(`/api/v2/history/load?id=${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取历史失败");
    await applyAnalysisData(data, "读取历史完成");
  } catch (error) {
    setStatus(error.message || "读取历史失败");
  } finally {
    loadHistoryButton.disabled = false;
  }
}

function noteFor(pathValue, type) {
  const note = appData?.treeNotes?.find((item) => item.path === pathValue && item.type === type);
  return note || {
    label: pathValue.split("/").pop(),
    importance: "normal",
  };
}

function functionsForFile(filePath) {
  return (appData?.functions || []).filter((fn) => fn.file === filePath).sort((a, b) => a.startLine - b.startLine);
}

function fileByPath(filePath) {
  return appData?.files?.find((file) => file.path === filePath);
}

function annotationForFunction(functionId) {
  return appData?.keyAnnotations?.find((item) => item.functionId === functionId);
}

function functionById(functionId) {
  return appData?.functions?.find((fn) => fn.id === functionId);
}

function buildTree(files) {
  const root = { name: "", path: "", type: "directory", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let cursor = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const itemPath = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1;
      if (!cursor.children.has(part)) {
        cursor.children.set(part, {
          name: part,
          path: itemPath,
          type: isFile ? "file" : "directory",
          children: new Map(),
        });
      }
      cursor = cursor.children.get(part);
    }
  }
  return root;
}

function renderTree() {
  if (!appData) {
    treeRoot.innerHTML = "";
    return;
  }
  const tree = buildTree(appData.files || []);
  treeRoot.innerHTML = "";
  treeRoot.appendChild(renderTreeChildren(tree.children, 0));
  treeMeta.textContent = `${appData.files.length} files · ${appData.functions.length} functions`;
}

function renderTreeChildren(children, depth) {
  const wrapper = document.createElement("div");
  wrapper.className = depth ? "tree-children" : "";
  const nodes = [...children.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const node of nodes) {
    const note = noteFor(node.path, node.type);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tree-item ${note.importance === "core" ? "important" : ""} ${selectedFilePath === node.path ? "active" : ""}`;
    const expanded = node.type === "directory" ? expandedDirs.has(node.path) : expandedFiles.has(node.path);
    const hasFunctions = node.type === "file" && functionsForFile(node.path).length > 0;
    const prefix = node.type === "directory" || hasFunctions ? (expanded ? "▾ " : "▸ ") : "";
    button.innerHTML = `<span class="tree-name">${prefix}${escapeHtml(node.name)}</span><span class="tree-note">${escapeHtml(note.label)}</span>`;

    if (node.type === "directory") {
      button.addEventListener("click", () => {
        if (expandedDirs.has(node.path)) expandedDirs.delete(node.path);
        else expandedDirs.add(node.path);
        renderTree();
      });
    }

    if (node.type === "file") {
      button.addEventListener("click", () => {
        if (selectedFilePath === node.path && expandedFiles.has(node.path)) {
          expandedFiles.delete(node.path);
          renderTree();
          return;
        }
        openFile(node.path, { expandFunctions: true });
      });
    }
    wrapper.appendChild(button);

    if (node.type === "directory" && expandedDirs.has(node.path)) {
      wrapper.appendChild(renderTreeChildren(node.children, depth + 1));
    }

    if (node.type === "file" && expandedFiles.has(node.path)) {
      wrapper.appendChild(renderFunctionList(node.path));
    }
  }
  return wrapper;
}

function renderFunctionList(filePath) {
  const wrapper = document.createElement("div");
  wrapper.className = "function-list";
  for (const fn of functionsForFile(filePath)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `function-item ${fn.importance === "core" || fn.isKey ? "important" : ""}`;
    button.innerHTML = `<span class="tree-name">${escapeHtml(fn.fullName)}</span><span class="tree-note">${escapeHtml(fn.label || "")}</span>`;
    button.addEventListener("click", () => jumpToFunctionDefinition(fn.id));
    wrapper.appendChild(button);
  }
  return wrapper;
}

async function ensureMonaco() {
  if (monacoApi) return monacoApi;
  if (!window.require) {
    throw new Error("Monaco loader unavailable.");
  }
  return new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" } });
    window.require(["vs/editor/editor.main"], () => {
      monacoApi = window.monaco;
      monacoApi.editor.defineTheme("nanobot-light", {
        base: "vs",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#fbfcfe",
          "editorLineNumber.foreground": "#9aa4b2",
          "editor.selectionBackground": "#dff3f0",
          "editorCursor.foreground": "#0f766e",
        },
      });
      resolve(monacoApi);
    }, reject);
  });
}

async function initEditor() {
  if (editor) return;
  try {
    const monaco = await ensureMonaco();
    editor = monaco.editor.create(editorRoot, {
      value: "",
      language: "python",
      theme: "nanobot-light",
      readOnly: true,
      minimap: { enabled: false },
      lineNumbers: "on",
      wordWrap: "off",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "Cascadia Code, Fira Code, Consolas, monospace",
      renderLineHighlight: "none",
    });
    editor.onDidScrollChange(() => updateFloatingPanelFromViewport());
    editor.onMouseDown((event) => {
      if (!event.target?.position) return;
      const lineNumber = event.target.position.lineNumber;
      const annotation = annotationsForCurrentFile().find((item) => lineNumber >= item.functionRange.startLine && lineNumber <= item.functionRange.endLine);
      if (annotation) {
        activeAnnotation = annotation;
        renderFloatingPanel();
      }
    });
  } catch (error) {
    editorRoot.classList.add("hidden");
    plainCodeFallback.classList.remove("hidden");
    setStatus(`Monaco 加载失败，使用纯文本模式：${error.message}`);
  }
}

async function getFileContent(filePath) {
  if (fileContentCache.has(filePath)) {
    return fileContentCache.get(filePath);
  }
  const local = fileByPath(filePath);
  if (local?.content) {
    fileContentCache.set(filePath, local.content);
    return local.content;
  }
  const localPath = appData?.project?.defaultBranch === "local" ? appData.project.url : "";
  const localParam = localPath ? `&localPath=${encodeURIComponent(localPath)}` : "";
  const response = await fetch(`/api/v2/file?path=${encodeURIComponent(filePath)}${localParam}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load file.");
  fileContentCache.set(filePath, data.content);
  return data.content;
}

async function openFile(filePath, options = {}) {
  selectedFilePath = filePath;
  if (options.expandFunctions !== false) {
    expandedFiles.add(filePath);
  }
  expandAncestors(filePath);
  currentPath = filePath;
  renderTree();
  currentFile.textContent = filePath;
  currentFileMeta.textContent = "";
  setStatus("加载源码中...");
  const content = await getFileContent(filePath);
  const lineCount = content.split(/\r?\n/).length;
  currentFileMeta.textContent = `${lineCount} lines`;

  if (editor) {
    const model = monacoApi.editor.createModel(content, languageForFile(filePath));
    const oldModel = editor.getModel();
    editor.setModel(model);
    if (oldModel) oldModel.dispose();
    applyDecorations();
  } else {
    plainCodeFallback.textContent = content;
  }

  setStatus(appData?.project?.summary || "源码已加载");
  if (options.line) {
    jumpToLine(options.line, options.flashName);
  }
}

function languageForFile(filePath) {
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".md")) return "markdown";
  if (filePath.endsWith(".toml") || filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return "yaml";
  return "plaintext";
}

function annotationsForCurrentFile() {
  return (appData?.keyAnnotations || []).filter((item) => item.file === currentPath);
}

function functionsForCurrentFile() {
  return functionsForFile(currentPath || "");
}

function applyDecorations() {
  if (!editor || !monacoApi || !currentPath) return;
  const model = editor.getModel();
  if (!model) return;
  const decorations = [];

  for (const fn of functionsForCurrentFile()) {
    const maxCol = model.getLineMaxColumn(fn.startLine);
    decorations.push({
      range: new monacoApi.Range(fn.startLine, maxCol, fn.startLine, maxCol),
      options: {
        after: {
          content: `  ${fn.label || ""}`,
          inlineClassName: "inline-function-note",
        },
      },
    });
  }

  for (const annotation of annotationsForCurrentFile()) {
    for (let line = annotation.functionRange.startLine; line <= annotation.functionRange.endLine; line += 1) {
      decorations.push({
        range: new monacoApi.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: "key-function-line" },
      });
    }

    for (const block of annotation.blocks || []) {
      for (let line = block.startLine; line <= block.endLine; line += 1) {
        decorations.push({
          range: new monacoApi.Range(line, 1, line, 1),
          options: { isWholeLine: true, className: "anchor-line" },
        });
      }
    }

    for (const variable of annotation.highlightVariables || []) {
      const regex = new RegExp(`\\b${escapeRegExp(variable)}\\b`, "g");
      for (let line = annotation.functionRange.startLine; line <= annotation.functionRange.endLine; line += 1) {
        const text = model.getLineContent(line);
        let match;
        while ((match = regex.exec(text))) {
          decorations.push({
            range: new monacoApi.Range(line, match.index + 1, line, match.index + variable.length + 1),
            options: { inlineClassName: "var-token" },
          });
        }
      }
    }
  }

  decorationIds = editor.deltaDecorations(decorationIds, decorations);
  applyViewZones();
  updateFloatingPanelFromViewport();
}

function applyViewZones() {
  if (!editor || !monacoApi) return;
  editor.changeViewZones((accessor) => {
    for (const id of viewZoneIds) accessor.removeZone(id);
    viewZoneIds = [];
    for (const annotation of annotationsForCurrentFile()) {
      for (const block of annotation.blocks || []) {
        const domNode = document.createElement("div");
        domNode.className = "block-view-zone";
        domNode.textContent = block.label || "关键逻辑";
        const id = accessor.addZone({
          afterLineNumber: Math.max(0, block.startLine - 1),
          heightInLines: 1,
          domNode,
        });
        viewZoneIds.push(id);
      }
    }
  });
}

function jumpToLine(line, flashName) {
  if (!editor || !monacoApi) return;
  editor.revealLineNearTop(line, monacoApi.editor.ScrollType.Smooth);
  editor.setPosition({ lineNumber: line, column: 1 });
  if (flashName) {
    flashFunctionName(line, flashName);
  }
}

function flashFunctionName(line, name) {
  if (!editor || !monacoApi || !name) return;
  const model = editor.getModel();
  const text = model.getLineContent(line);
  const index = text.indexOf(name.split(".").pop());
  const startCol = index >= 0 ? index + 1 : 1;
  const endCol = index >= 0 ? startCol + name.split(".").pop().length : model.getLineMaxColumn(line);
  jumpDecorationIds = editor.deltaDecorations(jumpDecorationIds, [{
    range: new monacoApi.Range(line, startCol, line, endCol),
    options: { inlineClassName: "jump-token" },
  }]);
  setTimeout(() => {
    if (editor) jumpDecorationIds = editor.deltaDecorations(jumpDecorationIds, []);
  }, 1000);
}

async function jumpToFunctionDefinition(functionId) {
  const fn = functionById(functionId);
  if (!fn) return;
  await openFile(fn.file, { line: fn.startLine, flashName: fn.name });
}

async function jumpToFlowFunction(flowFn) {
  const fn = functionById(flowFn.functionId);
  if (!fn) return;
  await openFile(fn.file, { line: fn.startLine, flashName: fn.name, expandFunctions: true });
  const annotation = annotationForFunction(fn.id);
  if (annotation) {
    activeAnnotation = annotation;
    renderFloatingPanel();
  }
}

function updateFloatingPanelFromViewport() {
  if (!editor || !currentPath) return;
  if (dragState) return;
  if (activeAnnotation && activeAnnotation.file === currentPath && isAnnotationVisible(activeAnnotation)) {
    renderFloatingPanel();
    return;
  }
  const visible = editor.getVisibleRanges()[0];
  if (!visible) {
    hideFloatingPanel();
    return;
  }
  const firstVisible = annotationsForCurrentFile().find((item) => item.functionRange.endLine >= visible.startLineNumber && item.functionRange.startLine <= visible.endLineNumber);
  if (firstVisible) {
    activeAnnotation = firstVisible;
    renderFloatingPanel();
  } else {
    hideFloatingPanel();
  }
}

function isAnnotationVisible(annotation) {
  const visible = editor?.getVisibleRanges()[0];
  return Boolean(visible && annotation.functionRange.endLine >= visible.startLineNumber && annotation.functionRange.startLine <= visible.endLineNumber);
}

function hideFloatingPanel() {
  floatingPanel.classList.add("hidden");
}

function renderFloatingPanel() {
  if (!activeAnnotation || activeAnnotation.file !== currentPath) {
    hideFloatingPanel();
    return;
  }
  const fn = functionById(activeAnnotation.functionId);
  floatingTitle.textContent = fn?.fullName || "关键函数";
  floatingBody.innerHTML = renderVariables(activeAnnotation);
  floatingPanel.classList.remove("hidden");
  if (floatingPosition) {
    floatingPanel.style.left = `${floatingPosition.left}px`;
    floatingPanel.style.top = `${floatingPosition.top}px`;
    floatingPanel.style.right = "auto";
  } else {
    floatingPanel.style.left = "auto";
    floatingPanel.style.right = "24px";
    floatingPanel.style.top = "50%";
  }
}

function renderVariables(annotation) {
  const vars = annotation.floatingPanel?.variables || {};
  const flows = vars.flows || legacyFlows(vars);
  return `
    <div class="flow-note">${escapeHtml(vars.note || "这段代码的数据流还没有详细说明。")}</div>
    <div class="variable-flows">
      ${flows.length ? flows.map(renderVariableFlow).join("") : "<div class=\"empty-flow\">暂无有价值变量说明</div>"}
    </div>
  `;
}

function legacyFlows(vars) {
  const outputs = Array.isArray(vars.outputs) ? vars.outputs : [];
  const inputs = Array.isArray(vars.inputs) ? vars.inputs : [];
  return outputs.slice(0, 2).map((output) => ({
    name: output,
    label: "当前值/用途需要重新分析补充",
    before: inputs.length ? inputs.join("、") : "函数内部构造",
    sources: inputs,
    after: output,
    effect: Array.isArray(vars.changes) ? vars.changes.join("；") : "",
  }));
}

function renderVariableFlow(flow) {
  const sources = Array.isArray(flow.sources) ? flow.sources : [];
  const left = sources.length ? sources.map(renderSourceNode).join("<span class=\"data-plus\">+</span>") : `<span class="data-node muted">${escapeHtml(flow.before || "输入数据")}</span>`;
  const value = flow.after && flow.after !== flow.name ? flow.after : (flow.before || "当前值待补充");
  return `
    <article class="variable-flow">
      <div class="data-flow-line">
        <div class="data-source-group">${left}</div>
        <div class="data-arrow">→</div>
        <div class="data-main-node">
          <code>${escapeHtml(flow.name || "变量")}</code>
          <span>${escapeHtml(flow.label || "它的含义待补充")}</span>
          <small>${escapeHtml(value)}</small>
        </div>
        <div class="data-arrow">→</div>
        <div class="data-effect-node">${escapeHtml(flow.effect || "后续用途待补充")}</div>
      </div>
    </article>
  `;
}

function renderSourceNode(value) {
  return `<span class="data-node">${escapeHtml(value)}</span>`;
}

function renderPills(items = []) {
  if (!items.length) return "<span class=\"tree-note\">暂无</span>";
  return items.map((item) => `<span class="var-pill">${escapeHtml(item)}</span>`).join("");
}

function renderFlows() {
  const tabs = appData?.flowTabs || [];
  flowTabsRoot.innerHTML = "";
  for (const tab of tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = tab.id === selectedFlowTab ? "active" : "";
    button.textContent = tab.label;
    button.addEventListener("click", () => {
      selectedFlowTab = tab.id;
      renderFlows();
    });
    flowTabsRoot.appendChild(button);
  }

  const tab = tabs.find((item) => item.id === selectedFlowTab);
  if (!tab || !tab.cards?.length) {
    flowContent.innerHTML = `<div class="flow-empty">${selectedFlowTab === "overview" ? "总览预留位" : "暂无流程卡片"}</div>`;
    return;
  }

  flowContent.innerHTML = tab.cards.map((card, index) => `
    <article class="flow-card">
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.summary || "")}</p>
      <div class="flow-functions">
        ${(card.functions || []).map((fn) => `<button type="button" data-function-id="${escapeHtml(fn.functionId)}" data-card-id="${escapeHtml(card.id)}">${escapeHtml(fn.displayName)}</button>`).join("")}
      </div>
    </article>
    ${index < tab.cards.length - 1 ? "<div class=\"flow-arrow\">↓</div>" : ""}
  `).join("");

  flowContent.querySelectorAll("[data-function-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const activeTab = (appData.flowTabs || []).find((item) => item.id === selectedFlowTab);
      const card = activeTab?.cards?.find((item) => item.id === button.dataset.cardId);
      const flowFn = card?.functions?.find((item) => item.functionId === button.dataset.functionId);
      if (flowFn) jumpToFlowFunction(flowFn);
    });
  });
}

function renderLogs() {
  if (!appData?.logs?.length) {
    logContent.textContent = "暂无调用日志";
    return;
  }
  const lines = appData.logs.map((entry) => {
    if (typeof entry === "string") return entry;
    const time = entry.localAt || (entry.at ? new Date(entry.at).toLocaleString() : "");
    const meta = entry.meta && Object.keys(entry.meta).length ? ` ${JSON.stringify(entry.meta)}` : "";
    return `${time} [${entry.stage}] ${entry.message}${meta}`;
  });
  lines.push("");
  lines.push("完整模型调用审计：GET /api/v2/model-logs");
  logContent.textContent = lines.join("\n");
}

async function applyAnalysisData(data, statusPrefix = "") {
  appData = data;
  selectedFlowTab = "prompt";
  fileContentCache.clear();
  expandedDirs.clear();
  expandedFiles.clear();
  hideFloatingPanel();
  activeAnnotation = null;
  currentPath = null;
  selectedFilePath = null;
  for (const file of appData.files || []) {
    if (file.content) fileContentCache.set(file.path, file.content);
  }
  renderTree();
  renderFlows();
  renderLogs();
  const firstKey = appData.functions.find((fn) => fn.isKey) || appData.functions[0];
  if (firstKey) await openFile(firstKey.file, { line: firstKey.startLine, flashName: firstKey.name });
  const elapsed = appData.project?.elapsedMs ? ` · ${Math.round(appData.project.elapsedMs / 1000)}s` : "";
  const prefix = statusPrefix || (appData.project?.loadedFromCache ? "读取缓存完成" : "完成");
  setStatus(`${prefix}：${appData.functions.length} functions · ${appData.keyAnnotations.length} key annotations${elapsed}`);
}

async function analyze(event) {
  event.preventDefault();
  const submitter = event.submitter || analyzeGithubButton;
  const source = submitter.dataset.source === "local" ? "local" : "github";
  const localPath = localPathInput.value.trim();
  if (source === "local" && !localPath) {
    setStatus("请先填写本地项目路径。");
    return;
  }
  saveSettings();
  analyzeGithubButton.disabled = true;
  analyzeLocalButton.disabled = true;
  submitter.textContent = "分析中";
  setStatus(source === "local"
    ? "正在读取本地源码、建立函数索引，并生成学习标注..."
    : "正在拉取 GitHub 仓库、建立函数索引，并生成学习标注...");
  try {
    await initEditor();
    const response = await fetch("/api/v2/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: apiKeyInput.value.trim(),
        baseUrl: baseUrlInput.value.trim(),
        model: modelInput.value.trim(),
        source,
        localPath,
        force: forceAnalyzeInput.checked,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      appData = { logs: data.logs || [] };
      renderLogs();
      throw new Error(data.error || "分析失败");
    }
    await applyAnalysisData(data);
    await loadHistoryList();
  } catch (error) {
    setStatus(error.message || "分析失败");
  } finally {
    analyzeGithubButton.disabled = false;
    analyzeLocalButton.disabled = false;
    analyzeGithubButton.textContent = "GitHub";
    analyzeLocalButton.textContent = "本地";
  }
}

function expandAncestors(filePath) {
  const parts = filePath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    expandedDirs.add(parts.slice(0, index).join("/"));
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setupFloatingPanel() {
  floatingClose.addEventListener("click", hideFloatingPanel);
  floatingDragHandle.addEventListener("mousedown", (event) => {
    const panelRect = floatingPanel.getBoundingClientRect();
    const left = panelRect.left;
    const top = panelRect.top;
    dragState = {
      offsetX: event.clientX - panelRect.left,
      offsetY: event.clientY - panelRect.top,
      parentLeft: 0,
      parentTop: 0,
      parentWidth: window.innerWidth,
      parentHeight: window.innerHeight,
    };
    floatingPosition = { left, top };
    floatingPanel.style.left = `${left}px`;
    floatingPanel.style.top = `${top}px`;
    floatingPanel.style.right = "auto";
    event.preventDefault();
  });
  window.addEventListener("mousemove", (event) => {
    if (!dragState) return;
    dragState.parentWidth = window.innerWidth;
    dragState.parentHeight = window.innerHeight;
    const maxLeft = Math.max(0, dragState.parentWidth - floatingPanel.offsetWidth);
    const maxTop = Math.max(0, dragState.parentHeight - floatingPanel.offsetHeight);
    floatingPosition = {
      left: Math.min(maxLeft, Math.max(0, event.clientX - dragState.parentLeft - dragState.offsetX)),
      top: Math.min(maxTop, Math.max(0, event.clientY - dragState.parentTop - dragState.offsetY)),
    };
    floatingPanel.style.left = `${floatingPosition.left}px`;
    floatingPanel.style.top = `${floatingPosition.top}px`;
    floatingPanel.style.right = "auto";
  });
  window.addEventListener("mouseup", () => {
    dragState = null;
  });
}

loadSettings();
setupFloatingPanel();
settingsForm.addEventListener("submit", analyze);
loadHistoryButton.addEventListener("click", loadSelectedHistory);
historySelect.addEventListener("focus", loadHistoryList);
historySelect.addEventListener("click", loadHistoryList);
loadHistoryList();
initEditor().catch(() => {});
