# Game Tuning Workbench / 游戏调优工作台

[English](#english) · [中文](#中文)

## English

Game Tuning Workbench is a Codex plugin for existing Three.js browser games. It analyzes game source and opens a local workbench where you can draft, preview, confirm, verify, and undo scoped changes. Current version: **0.4.1-beta.1**.

### Features

- Explore the game's story, gameplay flow, tuning parameters, and asset references with source-backed evidence.
- Keep edits in local drafts until you confirm a proposed ChangeSet.
- Compare the original game with a temporary preview when the game has a suitable start script.
- Review applied changes, build results, screenshots, and guarded undo records.
- Ask Codex to prepare scoped story or gameplay changes; source writes still require explicit confirmation.

The first release supports **Three.js projects only**. A numeric control appears only when its editable source and runtime consumer can be identified. Image and 3D-model generation providers are not connected yet. Automated screenshots can check loading and visible errors, but cannot prove gameplay or completion.

### Install from GitHub

Install Codex and Node.js, then run:

```bash
codex plugin marketplace add jorywow/game-tuning-workbench
codex plugin add game-tuning-workbench@game-tuning-workbench-release
```

Start a **new Codex task** in your Three.js game directory and ask: **“Open this game's tuning workbench.”** Codex will analyze the current game, launch the local workbench, and open it in a browser. On first use, choose “Explore first” or “Allow changes.” Allowing changes for the session does not apply a source edit by itself; every proposed change still requires confirmation.

To update a GitHub installation after a new release:

```bash
codex plugin marketplace upgrade game-tuning-workbench-release
codex plugin add game-tuning-workbench@game-tuning-workbench-release
```

Check the version with `codex plugin list`, then start a new task to load the updated skill.

### Develop locally

From the plugin directory, run `npm test`, `npm run test:integration`, and `npm run check`. Run `node scripts/package-release.mjs --public` before distributing a release. The local launcher is `scripts/open-workbench.mjs <game-directory>`. Screenshots optionally use Playwright; install it with `npm install --omit=dev` and `npm run setup:browser` if needed.

This public GitHub repository provides **Git marketplace distribution**. It is not a listing in the universal OpenAI plugin directory. See the [release notes](plugins/game-tuning-workbench/docs/novice-release.md) and [architecture](plugins/game-tuning-workbench/docs/product-architecture.md) for details.

### License

MIT. See [LICENSE](LICENSE).

## 中文

`game-tuning-workbench` 是面向普通游戏爱好者的 Codex 插件。它分析现有 Three.js 网页游戏，生成可理解的调优工作台，并把每次改动限制在独立、可确认、可验证、可撤销的 ChangeSet 中。

### 一句话开始（0.4.1-beta.1）

安装后，在游戏所在的 Codex 任务里说：**“打开这个游戏的调优工作台。”** Codex 会分析、启动并打开网页。不需要你选端口、输命令或传递修改文件。

首次使用只选“先看看”或“允许修改”，之后在同一页面走完：认识游戏 → 试着改一点 → 看看改了什么 → 检查与恢复。

- 草稿保存在本机，刷新或更换端口不会丢失（需要使用相同工作台目录）。
- 故事、玩法修改可直接点击“让 Codex 实施这份修改”。实际先准备待确认方案，不直接改源码。复杂修改使用已登录的 Codex CLI 和账号额度。
- 可试玩原版和准备好的临时副本；确认后有构建结果、修改记录、自动截图和恢复入口。
- 故事可加参考图，玩法按流程图展示，素材候选可并排比较。生图、生模型供应商及程序生成素材替换尚未接入，不能把参考图当成已经替换的模型。
- 自动检查证明页面/画布加载与未观察到运行错误，不证明游戏可通关或玩法正确。仍需人工试玩检查。
- “手感与难度”会自动识别运行时真正读取的显式调优契约，以及一部分常见的平铺数值配置（例如飞行控制器的 `DEFAULTS.forwardSpeed`）。内联数字、复杂预设和计算值仍需 Codex 先为具体游戏接入参数；打开工作台本身不会改动游戏源码。

启动入口：`node scripts/open-workbench.mjs <游戏目录>`。由 Codex 执行即可，普通用户无需复制命令。

自动截图可选依赖：`npm install --omit=dev`，然后 `npm run setup:browser`。已有 Chrome 时可作为后备浏览器；缺少依赖会明确标记“未检查”，不影响保存与撤销。

新版架构和验收说明见 [docs/novice-release.md](plugins/game-tuning-workbench/docs/novice-release.md)。

### 旧版兼容能力

- 预览世界观、核心玩法、可调数值和素材槽位；
- 为世界观卡片、单条玩法规则、单个数值和单个素材槽位分别保存浏览器草稿；
- 将草稿导出为 ChangeSet `0.2.0`；
- 对精确绑定的数值进行 A/B 临时副本试玩、二次确认、应用、验证和撤销；
- 将世界观、玩法和素材操作明确标记为 `codex-assisted`，由 Codex 对照源码证据逐项实施；
- 为第三方生图、生模型服务生成统一请求，暂不绑定具体供应商。

### 安装与分发状态

本仓库通过 Git marketplace 公开分发，**尚未上架 OpenAI 公共插件目录**。已安装 Codex 和 Node.js 的用户可以运行：

```bash
codex plugin marketplace add jorywow/game-tuning-workbench
codex plugin add game-tuning-workbench@game-tuning-workbench-release
```

安装后请新建一个 Codex 任务，再让它“为当前 Three.js 游戏生成调优工作台”。新任务会加载刚安装的 Skill。

### 升级

1. 运行 `codex plugin marketplace upgrade game-tuning-workbench-release` 刷新仓库。
2. 运行 `codex plugin add game-tuning-workbench@game-tuning-workbench-release` 安装新版快照。
3. 用 `codex plugin list` 确认显示的新版本。
4. 新建 Codex 任务验证版本。

如果此前注册的是本地测试包目录，可先运行 `codex plugin marketplace remove game-tuning-workbench-release`，再执行上面的 GitHub 安装命令。

新版草稿在本地服务中保存；过期草稿会提示并保留原始数据。0.3 旧页面与浏览器草稿仍可使用，但不同网页地址之间不会偷偷转移浏览器数据，升级前请保留旧页面处理未完成草稿。

### 从源码开发

在插件根目录运行：

```bash
node scripts/validate-contracts.mjs
node --test tests/*.test.mjs
npm run test:integration
node scripts/package-release.mjs
```

生成的 marketplace 目录位于 `dist/`，可用于发布前本地验证。

分发前使用 `node scripts/package-release.mjs --public`，会检查发布身份、许可证、目标仓库、个人路径和疑似密钥，排除个人游戏分析、历史和本地依赖。

本项目采用 MIT License，详见 [LICENSE](LICENSE)。

### ChangeSet 应用边界

- `automatic`：当前仅支持带 `file + symbol + lineHint + access: editable` 的有限数值配置，由本地应用引擎处理。
- `codex-assisted`：世界观、玩法规则和素材变更。源码绑定只表示调查入口，Codex 必须检查证据并做最小实现。
- 素材的 `selectedOutput` 为 `null` 时只代表生成简报，绝不能覆盖当前素材。

详细架构见 [docs/product-architecture.md](plugins/game-tuning-workbench/docs/product-architecture.md)。
