const settingsForm = document.getElementById("settingsForm");
const analyzeGithubButton = document.getElementById("analyzeGithubButton");
const analyzeLocalButton = document.getElementById("analyzeLocalButton");
const apiKeyInput = document.getElementById("apiKeyInput");
const localPathInput = document.getElementById("localPathInput");
const baseUrlInput = document.getElementById("baseUrlInput");
const modelInput = document.getElementById("modelInput");
const historySelect = document.getElementById("historySelect");
const loadHistoryButton = document.getElementById("loadHistoryButton");
const fullscreenButton = document.getElementById("fullscreenButton");
const settingsButton = document.getElementById("settingsButton");
const settingsPopover = document.getElementById("settingsPopover");
const settingsClose = document.getElementById("settingsClose");
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
const JOURNEY_ORDER = [
  "simple-qa",
  "context-assembly",
  "tool-calling",
  "mcp-calling",
  "memory-system",
  "skills-loading",
  "state-scheduling",
  "fallback",
];
const JOURNEY_LABELS = {
  "simple-qa": "简单问答",
  "context-assembly": "上下文",
  "tool-calling": "工具调用",
  "mcp-calling": "MCP调用",
  "memory-system": "记忆系统",
  "skills-loading": "skills系统",
  "state-scheduling": "状态调度",
  fallback: "异常兜底",
};
let appData = null;
let editor = null;
let monacoApi = null;
let currentPath = null;
let selectedFilePath = null;
let selectedFlowTab = "prompt";
let activeAnnotation = null;
let decorationIds = [];
let jumpDecorationIds = [];
let focusedDecorationIds = [];
let viewZoneIds = [];
let floatingPosition = null;
let dragState = null;
let focusedFunctionId = null;
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
  }));
}

function loadSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    apiKeyInput.value = "";
    localPathInput.value = settings.localPath || "";
    baseUrlInput.value = settings.baseUrl || "https://api.openai.com/v1";
    modelInput.value = settings.model || "gpt-4.1-mini";
  } catch {
    // Ignore broken local settings.
  }
}

function setStatus(message) {
  statusText.textContent = message;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (error) {
    setStatus(`全屏切换失败：${error.message}`);
  }
}

function syncFullscreenButton() {
  const active = Boolean(document.fullscreenElement);
  fullscreenButton.textContent = active ? "退出" : "全屏";
  fullscreenButton.title = active ? "退出全屏" : "全屏阅读";
  fullscreenButton.setAttribute("aria-label", active ? "退出全屏" : "全屏阅读");
}

function setSettingsOpen(open) {
  settingsPopover.classList.toggle("hidden", !open);
  settingsButton.setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleSettings() {
  setSettingsOpen(settingsPopover.classList.contains("hidden"));
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
    setSettingsOpen(false);
  } catch (error) {
    setStatus(error.message || "读取历史失败");
  } finally {
    loadHistoryButton.disabled = false;
  }
}

function noteFor(pathValue, type) {
  const note = appData?.treeNotes?.find((item) => item.path === pathValue && item.type === type);
  return note || {
    label: "",
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
    const fn = functionById(annotation.functionId);
    const fnName = fn?.name || fn?.fullName?.split(".").pop();
    const line = fn?.startLine || annotation.functionRange.startLine;
    if (fnName) {
      const text = model.getLineContent(line);
      const index = text.indexOf(fnName);
      if (index >= 0) {
        decorations.push({
          range: new monacoApi.Range(line, index + 1, line, index + fnName.length + 1),
          options: { inlineClassName: "key-function-name-token" },
        });
      }
    }
  }

  decorationIds = editor.deltaDecorations(decorationIds, decorations);
  applyFocusedFunctionDecoration();
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
  focusedFunctionId = fn.id;
  await openFile(fn.file, { line: fn.startLine, expandFunctions: true });
  const annotation = annotationForFunction(fn.id);
  applyFocusedFunctionDecoration();
  if (annotation) {
    activeAnnotation = annotation;
    renderFloatingPanel();
  }
}

function applyFocusedFunctionDecoration() {
  if (!editor || !monacoApi || !focusedFunctionId) {
    if (editor) focusedDecorationIds = editor.deltaDecorations(focusedDecorationIds, []);
    return;
  }
  const fn = functionById(focusedFunctionId);
  if (!fn || fn.file !== currentPath) {
    focusedDecorationIds = editor.deltaDecorations(focusedDecorationIds, []);
    return;
  }
  const annotation = annotationForFunction(fn.id);
  const model = editor.getModel();
  const startLine = annotation?.functionRange?.startLine || fn.startLine;
  const endLine = annotation?.functionRange?.endLine || fn.endLine || fn.startLine;
  const name = fn.name || fn.fullName?.split(".").pop();
  const decorations = [];
  for (let line = startLine; line <= endLine; line += 1) {
    decorations.push({
      range: new monacoApi.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: "focused-function-line" },
    });
  }
  if (name) {
    const text = model.getLineContent(fn.startLine);
    const index = text.indexOf(name);
    if (index >= 0) {
      decorations.push({
        range: new monacoApi.Range(fn.startLine, index + 1, fn.startLine, index + name.length + 1),
        options: { inlineClassName: "jump-token" },
      });
    }
  }
  focusedDecorationIds = editor.deltaDecorations(focusedDecorationIds, decorations);
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
  floatingBody.innerHTML = renderScenarioFlow(activeAnnotation);
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

function renderScenarioFlow(annotation) {
  const scenarioFlow = annotation.floatingPanel?.scenarioFlow;
  if (!scenarioFlow) {
    return renderLegacyVariables(annotation);
  }
  const steps = Array.isArray(scenarioFlow.steps) ? scenarioFlow.steps : [];
  return `
    <section class="scenario-flow">
      <div class="scenario-card">
        <span class="scenario-label">场景</span>
        <strong>${escapeHtml(scenarioFlow.scenario || "等待 LLM 补充场景。")}</strong>
        ${scenarioFlow.summary ? `<p>${escapeHtml(scenarioFlow.summary)}</p>` : ""}
      </div>
      <div class="scenario-steps">
        ${steps.length ? steps.map(renderScenarioStep).join("<div class=\"scenario-arrow\">↓</div>") : "<div class=\"empty-flow\">等待 LLM 补充场景数据流</div>"}
      </div>
      ${scenarioFlow.output ? `<div class="scenario-output"><span>最终输出</span>${escapeHtml(scenarioFlow.output)}</div>` : ""}
    </section>
  `;
}

function renderScenarioStep(step, index) {
  return `
    <article class="scenario-step">
      <header>
        <span>${index + 1}</span>
        <strong>${escapeHtml(step.title || "步骤")}</strong>
        <small>${escapeHtml(`${step.startLine || "?"}-${step.endLine || "?"}`)}</small>
      </header>
      <div class="scenario-io">
        <div>
          <span>拿到</span>
          <p>${escapeHtml((Array.isArray(step.takes) && step.takes.length) ? step.takes.join(" + ") : "函数当前输入")}</p>
        </div>
        <div>
          <span>处理</span>
          <p>${escapeHtml(step.does || "等待 LLM 补充处理方式")}</p>
        </div>
        <div>
          <span>产出</span>
          <p>${escapeHtml(step.produces || "等待 LLM 补充产出")}</p>
        </div>
      </div>
      ${step.next ? `<footer>${escapeHtml(step.next)}</footer>` : ""}
    </article>
  `;
}

function renderLegacyVariables(annotation) {
  const vars = annotation.floatingPanel?.variables || {};
  const flows = vars.flows || legacyFlows(vars);
  return `
    <div class="flow-note">旧版变量流：${escapeHtml(vars.note || "这段代码的数据流还没有详细说明。")}</div>
    <div class="variable-flows legacy-flow">
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

function renderSourceNode(source) {
  const item = typeof source === "string" ? { name: source } : source;
  const detail = [item.detail, item.value, item.use].filter(Boolean).join("；");
  return `
    <span class="data-node">
      <code>${escapeHtml(item.name || "输入")}</code>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </span>
  `;
}

function renderPills(items = []) {
  if (!items.length) return "<span class=\"tree-note\">暂无</span>";
  return items.map((item) => `<span class="var-pill">${escapeHtml(item)}</span>`).join("");
}

function renderFlows() {
  if (Array.isArray(appData?.functions) && appData.functions.length) {
    renderAgentJourneys();
    return;
  }
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

function renderAgentJourneys() {
  const journeys = completeJourneys(appData?.agentJourneys || []);
  if (!journeys.length) {
    flowTabsRoot.innerHTML = "";
    flowContent.innerHTML = "<div class=\"flow-empty\">暂无 agent 旅程</div>";
    return;
  }
  if (!journeys.some((journey) => journey.id === selectedFlowTab)) {
    selectedFlowTab = journeys[0].id;
  }
  flowTabsRoot.innerHTML = "";
  for (const journey of journeys) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = journey.id === selectedFlowTab ? "active" : "";
    button.textContent = journeyTabLabel(journey);
    button.addEventListener("click", () => {
      selectedFlowTab = journey.id;
      renderFlows();
    });
    flowTabsRoot.appendChild(button);
  }

  const journey = journeys.find((item) => item.id === selectedFlowTab) || journeys[0];
  const fallbackHint = journey.source === "local-fallback"
    ? "<div class=\"journey-hint\">本地规则推断，等待 LLM 补充源码证据</div>"
    : "";
  flowContent.innerHTML = `
    <section class="journey-intro">
      <h3>${escapeHtml(journey.question || journey.title)}</h3>
      <p>${escapeHtml(journey.mentalModel || "这条旅程等待 LLM 补充机制说明。")}</p>
      ${fallbackHint}
    </section>
    ${(journey.steps || []).map((step, index) => `
      <article class="flow-card journey-step-card">
        <div class="journey-step-head">
          <span class="layer-pill ${escapeHtml(step.layer || "harness")}">${escapeHtml(layerName(step.layer))}</span>
          <h3>${escapeHtml(step.title || "机制步骤")}</h3>
        </div>
        <p>${escapeHtml(step.explain || "等待 LLM 补充这一步的 agent 机制说明。")}</p>
        <div class="flow-functions">
          ${(step.functionIds || []).map((functionId) => {
            const fn = functionById(functionId);
            return fn ? `<button type="button" data-function-id="${escapeHtml(functionId)}">${escapeHtml(fn.fullName)}</button>` : "";
          }).join("")}
        </div>
        ${!(step.functionIds || []).length ? "<div class=\"journey-hint\">暂无可靠源码证据</div>" : ""}
      </article>
      ${index < (journey.steps || []).length - 1 ? "<div class=\"flow-arrow\">↓</div>" : ""}
    `).join("")}
  `;
  flowContent.querySelectorAll("[data-function-id]").forEach((button) => {
    button.addEventListener("click", () => {
      jumpToFlowFunction({ functionId: button.dataset.functionId });
    });
  });
}

function completeJourneys(journeys) {
  const byKey = new Map();
  for (const journey of journeys || []) {
    const key = canonicalJourneyKey(journey);
    if (key && !byKey.has(key)) {
      byKey.set(key, { ...journey, id: key, title: JOURNEY_LABELS[key] });
    }
  }
  return JOURNEY_ORDER.map((key) => byKey.get(key) || {
    id: key,
    title: JOURNEY_LABELS[key],
    source: "local-fallback",
    question: `${JOURNEY_LABELS[key]}：等待新分析补充机制说明`,
    mentalModel: "旧存档缺少这条 agent 旅程。重新分析后会补齐源码证据。",
    steps: [],
  });
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

function journeyTabLabel(journey) {
  const id = String(journey?.id || "");
  const title = String(journey?.title || "");
  if (JOURNEY_LABELS[id]) return JOURNEY_LABELS[id];
  return title
    .replace("上下文装配", "上下文")
    .replace("memory 系统", "记忆系统")
    .replace("memory系统", "记忆系统")
    .replace("状态与调度", "状态调度")
    .slice(0, 6);
}

function layerName(layer) {
  if (layer === "prompt") return "Prompt";
  if (layer === "context") return "Context";
  return "Harness";
}

function renderLogs() {
  if (!logContent) {
    return;
  }
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
  focusedFunctionId = null;
  if (editor) focusedDecorationIds = editor.deltaDecorations(focusedDecorationIds, []);
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
  const prefix = statusPrefix || "完成";
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
    setSettingsOpen(false);
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
settingsButton.addEventListener("click", toggleSettings);
settingsClose.addEventListener("click", () => setSettingsOpen(false));
document.addEventListener("mousedown", (event) => {
  if (settingsPopover.classList.contains("hidden")) return;
  if (settingsPopover.contains(event.target) || settingsButton.contains(event.target)) return;
  setSettingsOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSettingsOpen(false);
});
loadHistoryButton.addEventListener("click", loadSelectedHistory);
historySelect.addEventListener("focus", loadHistoryList);
historySelect.addEventListener("click", loadHistoryList);
fullscreenButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", syncFullscreenButton);
loadHistoryList();
initEditor().catch(() => {});
