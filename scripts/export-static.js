const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache", "source-atlas");
const PUBLIC_DIR = path.join(ROOT, "public");
const OUT_DIR = path.join(ROOT, "dist-site");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function latestHistoryFile() {
  if (!fs.existsSync(CACHE_DIR)) {
    throw new Error(`Cache directory not found: ${CACHE_DIR}`);
  }
  const files = fs.readdirSync(CACHE_DIR)
    .filter((name) => name.endsWith(".history.json"))
    .map((name) => {
      const filePath = path.join(CACHE_DIR, name);
      let savedAt = "";
      try {
        savedAt = readJson(filePath).savedAt || "";
      } catch {
        savedAt = "";
      }
      return {
        name,
        filePath,
        rank: savedAt ? Date.parse(savedAt) : fs.statSync(filePath).mtimeMs,
      };
    })
    .filter((item) => Number.isFinite(item.rank))
    .sort((a, b) => b.rank - a.rank);

  if (!files.length) {
    throw new Error("No history snapshots found. Run an analysis first.");
  }
  return files[0];
}

function isSafeRelativePath(value) {
  return value && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

function hydrateLocalFileContents(result) {
  const projectUrl = result?.project?.url;
  const localRoot = projectUrl && fs.existsSync(projectUrl) ? path.resolve(projectUrl) : "";
  let hydrated = 0;
  let missing = 0;

  for (const file of result.files || []) {
    if (file.content || !isSafeRelativePath(file.path)) {
      continue;
    }
    if (!localRoot) {
      missing += 1;
      continue;
    }
    const absolute = path.resolve(localRoot, file.path.replaceAll("/", path.sep));
    if (!absolute.startsWith(localRoot + path.sep) || !fs.existsSync(absolute)) {
      missing += 1;
      continue;
    }
    try {
      file.content = fs.readFileSync(absolute, "utf8");
      file.lineCount = file.content.split(/\r?\n/).length;
      hydrated += 1;
    } catch {
      missing += 1;
    }
  }

  return { hydrated, missing };
}

function sanitizeForPublic(result, sourceHistory) {
  const clean = JSON.parse(JSON.stringify(result));
  const projectName = clean.project?.name || "agent-source-atlas";
  clean.project = {
    ...(clean.project || {}),
    repo: clean.project?.repo || projectName,
    url: "",
    defaultBranch: "static",
    exportedAt: new Date().toISOString(),
    historyId: sourceHistory.name.replace(/\.history\.json$/, ""),
  };
  clean.logs = [];
  return clean;
}

function buildIndexHtml() {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  html = html
    .replace('href="/styles.css"', 'href="styles.css"')
    .replace('src="/app.js"', 'src="app.js"')
    .replace('<script src="app.js"></script>', '<script src="static-analysis.js"></script>\n    <script src="app.js"></script>');
  return html;
}

function main() {
  const latest = latestHistoryFile();
  const payload = readJson(latest.filePath);
  const result = payload.result || payload;
  const hydratedResult = JSON.parse(JSON.stringify(result));
  const contentStats = hydrateLocalFileContents(hydratedResult);
  const publicResult = sanitizeForPublic(hydratedResult, latest);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  writeText(path.join(OUT_DIR, "index.html"), buildIndexHtml());
  copyFile(path.join(PUBLIC_DIR, "styles.css"), path.join(OUT_DIR, "styles.css"));
  copyFile(path.join(PUBLIC_DIR, "app.js"), path.join(OUT_DIR, "app.js"));
  writeText(
    path.join(OUT_DIR, "static-analysis.js"),
    `window.STATIC_ANALYSIS_DATA = ${JSON.stringify(publicResult)};\n`,
  );

  const summary = {
    exportedTo: OUT_DIR,
    history: latest.name,
    files: publicResult.files?.length || 0,
    hydratedFiles: contentStats.hydrated,
    missingFileContents: contentStats.missing,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
