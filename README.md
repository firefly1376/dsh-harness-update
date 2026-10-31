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
- 检查更新（默认 release 通道）：`git fetch --tags` + 取最新的官方发布 tag（`dsh-v*` 的正式版或 rc 线，
  例如 `dsh-v0.2.1-rc.5`），与本地 `package.json` 的版本比对；alpha/beta 预发布快照不算发布版，不会被提示
- 检查在**后台**跑：POST 立刻返回，界面靠轮询 status 显示「检查中…」，慢 fetch 不再被误判为失败，
  连点两次也只会有一个 fetch（不会抢 ref 锁）
- 更新（release 通道）：git fetch --tags → git checkout --detach <tag> → pnpm install --frozen-lockfile →
  pnpm clean → pnpm build:official
- 只有一次检查**确实跑完**且找不到更新的 tag 时才显示「已是最新」；检查失败会显示原因，并保留上一次已知的可更新版本
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
| channel | release | `release` = 跟官方发布 tag（推荐）；`branch` = 老行为，跟远端分支上的 package.json 版本 |
| tagPrefix | dsh-v | release 通道认的 tag 前缀 |
| branch | master | 跟随的分支，只在 `channel: branch` 时生效 |
| pnpmCommand | pnpm | pnpm 路径或命令名（按 PATH+PATHEXT 解析） |
| stateFile | ~/.dsh-harness-update/state.json | 状态文件（进度、上次检查时间、回滚点） |
| checkTimeoutMs | 900000 | 单次 git fetch 超时 |
| stepTimeoutMs | 1800000 | install / clean / build 各自超时 |

## 路由

/harness-update/api/{status,check,install,rollback} —— 同源 JSON。install/rollback 立即返回，
进度通过轮询 status 获取。

## 已知边界

- 只适用于 **git 检出**安装的 DSH；npm 安装的没有可更新的检出。
- **发布线与 master 是两条线**：发布 tag 是从较早的 master 点切出来的，切过去会退掉本地比它多的
  master 开发提交（面板会把条数写出来，回滚点也记着）。这正是「跟发布版」和「跟 master 开发版」
  的区别，不是 bug；要跟开发版把 `channel` 设成 `branch`。
- 发布 tag 对应的检出是**游离 HEAD**（`git checkout --detach`）：没有本地分支，`git pull` 不适用，
  回滚靠面板的「回滚」按钮（`git reset --hard` 到更新前的 SHA）。
- 不做后台自动检查（没有轮询），只在点击按钮时工作，避免后台 git fetch 拖慢启动。
- 要求 DSH >= 0.2.0-rc.2（见 package.json 的 dsh.engines）。
- 首次 git fetch 可能较慢（该仓库的 pack 约 27MB）；慢速直连时请确认代理可用，
  否则会等到 checkTimeoutMs 超时。
- Windows 专属处理已内置（.cmd/PATHEXT/ComSpec），其他平台走普通 PATH 解析。

## 自测入口

宿主半边导出 __internals = { resolveCommand, runCommand, tailOf, trackedChanges, parseVersion,
compareVersions, isReleaseVersion, createUpdater }，可以脱离 DSH 单独验证：

    node --input-type=module -e "const m = await import('./lib/index.js'); console.log(m.__internals.compareVersions('0.2.1-rc.5','0.2.1-rc.3'))"

## 变更记录

### 0.1.3

- **修「检查失败之后又跳成已是最新」**：`check()` 原先在 fetch 之前就写 lastCheckedAt、清空
  available，界面又把「没有 available」当成「已是最新」，于是检查中途、检查失败、刚点按钮的
  一瞬间都在宣称最新。现在只有一次检查确实跑完且无更新才这么说，失败会显示原因。
- **修检查超时误判与 ref 锁冲突**：客户端 POST /check 只等 15s，而服务端 fetch 预算 900s，
  慢一点就必然「失败」而服务端还在跑；再点一次就有两个 fetch 抢 `refs/remotes/*`，报
  `cannot lock ref ... is at X but expected Y`。现在检查改为后台执行、POST 立刻返回，且
  进行中的检查会被复用，不会再并发 fetch。
- **可更新版本改看官方发布 tag**（`channel: release`，默认）：之前读 `origin/master:package.json`，
  于是把 master 的开发版号（如 0.2.2-alpha.2）当成「可更新版本」，还配上「落后 988 个提交」
  这种跨线无意义的数字。现在取最新 `dsh-v*` 发布 tag（正式版或 rc 线）按 semver 比对，
  并显示该 tag 与本机的双向提交差。
- 未跟踪文件（如本机 `?? dshqqbot/`）不再阻止更新：只有已跟踪文件有改动时才暂停。
- 旧版本的状态文件在升级后自动作废 available 缓存与那次旧代码路径记下的检查错误（结构变了，
  不能拿旧的开发版号或不再可能复现的 fetch 锁错误继续显示）；「上一次更新被中断」的记录仍然保留。

### 0.1.2

- 设置页在「更新中 / 回滚中 / 待重启」时增加一行说明：构建期页面可能自动刷新或白屏，属预期，
  完成后需重启。之前这一步只能从「页面突然白了」自己猜。
- README 补充重启时机的判定口径。

### 0.1.1

- 无更新时更新按钮呈禁用态；旧步骤日志按需显示。

## 许可

MIT
