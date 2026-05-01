# Nanobot Source Atlas

Nanobot Source Atlas is a local read-only source learning page for [HKUDS/nanobot](https://github.com/HKUDS/nanobot).

The v2 product is no longer a report generator. It is a three-pane source reading workspace:

- Left: project map with directories, files, functions, short labels, and important items.
- Center: read-only Monaco code view with key-function ranges, code-block notes, variable highlighting, and a draggable explanation panel.
- Right: Prompt / Context / Harness flow tabs that connect agent-building concepts back to real functions.

## Run

```powershell
node .\server.js
```

Open:

```text
http://127.0.0.1:3939
```

If port `3939` is already occupied, run on another port:

```powershell
$env:PORT='3944'; node .\server.js
```

## Use

1. Open the local page.
2. Optionally enter an OpenAI-compatible API key, base URL, and model.
3. Click `GitHub` to analyze the public nanobot repository.
4. Or enter a local project path and click `本地` to analyze downloaded source code without calling GitHub.
5. Leave `重新分析` unchecked to reuse the on-disk cache. Check it only when you want to spend tokens again and refresh the analysis.

If no API key is provided, the app still builds a local fallback view from repository facts, directory structure, Python function indexing, and path heuristics. With an API key, it also asks the LLM to produce tree labels, flow cards, and key-code annotations.

Use local analysis when anonymous GitHub API requests hit rate limits. The local mode expects a filesystem directory, for example:

```text
D:\code\nanobot
```

Analysis results are cached under `.cache/source-atlas/`. The cache stores generated source-learning data and LLM audit logs, but never stores your API key. The browser settings cache also does not persist the API key.

Every new analysis also writes a history snapshot. Use the `历史分析` selector in the top bar to switch between older analyses without spending tokens again.

## Current API

- `GET /api/health`: service health and defaults.
- `POST /api/v2/analyze`: analyzes either `HKUDS/nanobot` or a local source directory.
- `GET /api/v2/file?path=...`: fetches a single text file from nanobot.
- `GET /api/v2/file?path=...&localPath=...`: fetches a single text file from a local source directory.
- `GET /api/v2/logs`: returns the latest analysis log snapshot with UTC and Asia/Shanghai local time.
- `GET /api/v2/model-logs`: returns full LLM audit logs, including assembled messages, system prompt, user prompt, raw model responses, repaired responses, and parsed JSON.
- `GET /api/v2/history`: lists saved analysis snapshots.
- `GET /api/v2/history/load?id=...`: loads one saved analysis snapshot and makes its model logs current.

`/api/v2/logs` is the stage-level run log. Use `/api/v2/model-logs` when debugging prompt composition, context selection, or bad LLM labels.

## Verification

```powershell
node --check .\server.js
node --check .\public\app.js
```

Real GitHub smoke test used during implementation:

- Repository: `HKUDS/nanobot`
- Files returned to UI: `260`
- Python functions indexed: `990`
- Local fallback key annotations: `16`
- Flow tabs: `4`

## Notes

- Monaco Editor is loaded from CDN for the read-only code view.
- This product intentionally does not support code editing, debugging, terminals, git operations, private repositories, or a general IDE workflow.
