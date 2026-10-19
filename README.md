# dsh-harness-update

DeepSeek Harness（DSH）本体自更新插件：设置页一行完成「检查更新 / 更新 / 回滚」。

Self-update for DeepSeek Harness **git-source** installs — version check, one-click update
(pull → install → clean → build), rollback, per-step timing, and the failed step's real output tail.

## 它修掉了什么

用来替代已停更的 dsh-self-update（0.4.0）。那个插件有三个硬伤：

1. Windows 上 pnpm/npm 是 .cmd 外壳，Node 不能直接 spawn → 永远卡在「安装依赖」失败，
   而且 tail 是空的（几毫秒就返回，看起来像命令根本没执行）。
2. git fetch 超时硬编码 180s，而首次冷 fetch 这个 27MB 的 pack 需要约 240s → 必然失败。
3. 「检查时间」只在成功后落盘 → 失败时界面转一圈、时间不变，正是「点了没反应」的观感。

对应地，本插件：按 PATH+PATHEXT 解析命令（跳过 Windows 上无法执行的 POSIX 脚本），
.cmd/.bat 一律经 ComSpec 以 windowsVerbatimArguments 启动，每一步都保留输出 tail，
检查尝试后立即写入检查时间，fetch 超时放宽到 15 分钟。

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

更新或回滚完成后需要**重启 DSH** 才会加载新构建；界面会提示「已更新，重启 DSH 后生效」，
重启后该提示自动消失。

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

## 许可

MIT
