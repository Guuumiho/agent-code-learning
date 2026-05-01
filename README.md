# Nanobot Source Atlas

Nanobot Source Atlas 是一个本地只读源码学习页面，当前主要用于阅读和理解 [HKUDS/nanobot](https://github.com/HKUDS/nanobot)。

三栏源码阅读工作台：

- 左侧：项目地图，展示目录、文件、函数、极短说明和重要项。
- 中间：只读 Monaco 源码区，展示关键函数底色、关键代码块说明、变量高亮和可拖动解释浮窗。
- 右侧：Prompt / Context / Harness 流程视角，把 agent 构建概念关联到真实函数。

##双击运行

```start.bat
```

## 使用方式

点击 `GitHub` 分析公开的 nanobot 仓库。
点击 `本地` 分析本地项目路径。
使用 `历史分析` 和 `读取` 查看之前保存过的分析结果，不会再次消耗 token。
左上角 `⛶`  ，全屏阅读。

不填写 API Key 时，系统仍会基于仓库事实、目录结构、Python 函数索引和本地规则生成兜底视图。填写 API Key 后，会额外调用 LLM 生成目录说明、流程卡片和关键代码注释。

当 GitHub 匿名请求触发 rate limit 时，建议把源码手动下载到本地，再用 `本地` 模式分析。
```

## 隐私与缓存

分析结果保存在 `.cache/source-atlas/`，其中包含生成后的源码学习数据和 LLM 调用审计日志。

不会保存或上传 API Key。浏览器本地设置也不会持久化 API Key。

每次点击 `GitHub` 或 `本地` 都会开始一次新的分析，并写入一条历史快照。之后可以通过 `历史分析` 下拉框切换到旧结果。


## 说明

- Monaco Editor 通过 CDN 加载，用作只读源码展示组件。
- `.cache/`、运行日志、维护文档不会被提交到 GitHub。
