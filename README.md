# dsh-harness-update

DeepSeek Harness（DSH）本体自更新插件：设置页一行完成「检查更新 / 更新 / 回滚」。

Self-update for DeepSeek Harness **git-source** installs — version check, one-click update
(pull → install → clean → build), rollback, per-step timing, and the failed step's real output tail.

## 安装

前置条件：DSH 是 **git 检出**安装（不是 npm 全局安装），且 git 与 pnpm 在 PATH 上。

从 GitHub 安装（推荐）：

    cd <你的 DSH 检出目录>
    pnpm dsh plugin --profile web add github:firefly1376/dsh-harness-update --config.minimumReleaseAge=0

本地开发安装（改源码即时生效）：

    git clone https://github.com/firefly1376/dsh-harness-update
    pnpm dsh plugin --profile web add link:<克隆目录> --config.minimumReleaseAge=0

装完**重启 DSH**：宿主半边（/harness-update/api 路由）安装后即热生效，
客户端半边（设置页那一行）在启动时注册，必须重启才会出现。

卸载：

    pnpm dsh plugin --profile web remove dsh-harness-update

## 使用

设置 → 通用设置 → **DSH 版本**：

- 显示当前版本、短 SHA、可回滚到的提交
- 检查更新：git fetch + 比较在远端后面几个提交、远端版本号
- 更新：git pull --ff-only → pnpm install --frozen-lockfile → pnpm clean → pnpm build:official
- 回滚：git reset --hard 到更新前的 SHA，再跑同样的三步构建
- 每一步显示状态与耗时（✓ / ✕ / ●），失败时把该步的真实输出 tail 显示在下面
- 上一次更新的步骤日志只在「运行中 / 失败 / 待重启」时显示，重启 DSH 或已是最新时自动收起
- 没有可用更新时「更新」按钮为禁用态，悬停提示原因

更新或回滚完成后需要**重启 DSH** 才会加载新构建；界面会提示「已更新，重启 DSH 后生效」，
重启后该提示自动消失。

更新途中（`clean` / `build` 阶段）客户端的构建产物会被整体替换，**已打开的页面会跟着热重载，
甚至白屏**——这是预期内的，不是崩溃。判断能不能重启看进度，不看页面：面板显示「已更新，重启
DSH 后生效」就可以重启；这时重启之后新版本才会生效。构建还在跑时重启会把这次更新记成
「上一次更新被中断」，得重新点一次。

## 配置

在 profile 的 cordis.patch.yml 里给插入项加 config（键全部可选）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| repoRoot | 自动探测 | DSH 检出目录。顺序：DSH_REPO_ROOT → 运行中的 apps/cli 所属检出 → cwd |
| remote | origin | git 远端名 |
| branch | master | 跟踪分支 |
| pnpmCommand | pnpm | pnpm 路径或命令名（按 PATH+PATHEXT 解析） |
| stateFile | ~/.dsh-harness-update/state.json | 状态文件（进度、上次检查时间、回滚点） |
| checkTimeoutMs | 900000 | 单次 git fetch 超时 |
| stepTimeoutMs | 1800000 | install / clean / build 各自超时 |

## 路由

/harness-update/api/{status,check,install,rollback} —— 同源 JSON。install/rollback 立即返回，
进度通过轮询 status 获取。

## 已知边界

- 只适用于 **git 检出**安装的 DSH；npm 安装的没有可更新的检出。
- 不做后台自动检查（没有轮询），只在点击按钮时工作，避免后台 git fetch 拖慢启动。
- 要求 DSH >= 0.2.0-rc.2（见 package.json 的 dsh.engines）。
- 首次 git fetch 可能较慢（该仓库的 pack 约 27MB）；慢速直连时请确认代理可用，
  否则会等到 checkTimeoutMs 超时。
- Windows 专属处理已内置（.cmd/PATHEXT/ComSpec），其他平台走普通 PATH 解析。

## 自测入口

宿主半边导出 __internals = { resolveCommand, runCommand, tailOf, createUpdater }，
可以脱离 DSH 单独验证命令解析与执行：

    node --input-type=module -e "const m = await import('./lib/index.js'); console.log(m.__internals.resolveCommand('pnpm'))"

## 变更记录

### 0.1.2

- 设置页在「更新中 / 回滚中 / 待重启」时增加一行说明：构建期页面可能自动刷新或白屏，属预期，
  完成后需重启。之前这一步只能从「页面突然白了」自己猜。
- README 补充重启时机的判定口径。

### 0.1.1

- 无更新时更新按钮呈禁用态；旧步骤日志按需显示。

## 许可

MIT
