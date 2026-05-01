# Nanobot Source Atlas

Nanobot Source Atlas 是一个本地只读源码学习页面，当前主要用于阅读和理解 [HKUDS/nanobot](https://github.com/HKUDS/nanobot)。

v2 版本不再是报告生成器，而是一个三栏源码阅读工作台：

- 左侧：项目地图，展示目录、文件、函数、极短说明和重要项。
- 中间：只读 Monaco 源码区，展示关键函数底色、关键代码块说明、变量高亮和可拖动解释浮窗。
- 右侧：Prompt / Context / Harness 流程视角，把 agent 构建概念关联到真实函数。

## 运行

```powershell
node .\server.js
```

打开：

```text
http://127.0.0.1:3939
```

如果 `3939` 端口被占用，可以换端口：

```powershell
$env:PORT='3944'; node .\server.js
```

也可以直接运行：

```powershell
.\start.bat
```

## 使用方式

1. 打开本地页面。
2. 可选填写 OpenAI 兼容的 API Key、Base URL 和模型名。
3. 点击 `GitHub` 分析公开的 nanobot 仓库。
4. 或填写本地项目路径，点击 `本地` 分析已经下载好的源码。
5. 使用 `历史分析` 和 `读取` 查看之前保存过的分析结果，不会再次消耗 token。
6. 左上角 `⛶` 按钮可以进入或退出全屏阅读。

不填写 API Key 时，系统仍会基于仓库事实、目录结构、Python 函数索引和本地规则生成兜底视图。填写 API Key 后，会额外调用 LLM 生成目录说明、流程卡片和关键代码注释。

当 GitHub 匿名请求触发 rate limit 时，建议把源码手动下载到本地，再用 `本地` 模式分析。例如：

```text
D:\code\nanobot
```

## 隐私与缓存

分析结果保存在 `.cache/source-atlas/`，其中包含生成后的源码学习数据和 LLM 调用审计日志。

不会保存或上传 API Key。浏览器本地设置也不会持久化 API Key。

每次点击 `GitHub` 或 `本地` 都会开始一次新的分析，并写入一条历史快照。之后可以通过 `历史分析` 下拉框切换到旧结果。

## 当前接口

- `GET /api/health`：服务健康检查和默认配置。
- `POST /api/v2/analyze`：分析 `HKUDS/nanobot` 或本地源码目录。
- `GET /api/v2/file?path=...`：读取 nanobot 仓库里的单个文本文件。
- `GET /api/v2/file?path=...&localPath=...`：读取本地源码目录里的单个文本文件。
- `GET /api/v2/logs`：查看最近一次分析的阶段日志，包含 UTC 和 Asia/Shanghai 本地时间。
- `GET /api/v2/model-logs`：查看完整 LLM 调用审计，包括系统提示词、用户提示词、最终 messages、原始返回、修复返回和解析后的 JSON。
- `GET /api/v2/history`：列出保存过的分析历史。
- `GET /api/v2/history/load?id=...`：读取某一次历史分析，并把它的模型日志设为当前日志。

`/api/v2/logs` 用来看分析跑到哪一步。调试 prompt、上下文拼装和模型返回质量时，看 `/api/v2/model-logs`。

## 验证

```powershell
node --check .\server.js
node --check .\public\app.js
```

## 说明

- Monaco Editor 通过 CDN 加载，用作只读源码展示组件。
- 项目不提供代码编辑、调试、终端、git 操作、私有仓库读取或通用 IDE 能力。
- `.cache/`、运行日志、维护文档不会被提交到 GitHub。
