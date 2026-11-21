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
- **代理是自动的**：面板会显示「网络：http://127.0.0.1:7897（系统代理）」或「网络：直连…」。
  git 自己没有「用 Windows 系统代理」这个能力，只认 `http.proxy` / `http_proxy` 环境变量，
  所以插件每次调用都读一次系统代理（`HKCU\...\Internet Settings`）并显式交给 git 与 pnpm。
  Clash Verge / v2rayN 这类只改系统代理、不改 hosts 的工具因此能直接工作；Steam++ 那种改 hosts
  的加速器则走直连也不受影响。

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
| proxy | auto | `auto` = 每次调用读 Windows 系统代理（改了代理不用重启）；`none` = 强制直连；也可写 `http://host:port` 固定一个 |
| regenerateTracked | [] | 数组，repo 相对路径或 `*` 通配。列出的已跟踪文件视为「钩子生成物」：切换 tag 前丢弃其本地改动而不是拦住更新。真改动仍会拦 |
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
- **代理只认「交给它的那个」**：Windows 系统代理会被自动读取并注入 git/pnpm；但若你的加速器
  是改 hosts（Steam++/Watt）或纯 TUN 模式，插件看到的就是「无系统代理 → 直连」，这通常也能通。
  想强制某个代理就写 `proxy: http://127.0.0.1:7897`，想强制直连写 `proxy: none`。
- Windows 专属处理已内置（.cmd/PATHEXT/ComSpec），其他平台走普通 PATH 解析。

## 自测入口

宿主半边导出 __internals = { resolveCommand, runCommand, tailOf, trackedChanges, parseVersion,
compareVersions, isReleaseVersion, toProxyUrl, windowsSystemProxy, proxyEnv, createUpdater }，
可以脱离 DSH 单独验证：

    node --input-type=module -e "const m = await import('./lib/index.js'); console.log(m.__internals.windowsSystemProxy())"

## 变更记录

### 0.1.7

- **不再把旧的更新失败当成当前报错**：一次失败的更新会一直留在 `phase: 'failed'`，于是它的输出
  被无限期重放。实测出现过「22.9 小时前的 fetch 超时被当成刚刚的错误」，而当时最近一次检查其实
  是成功的——这会把一次早已失效的网络问题误诊成当前故障。现在 status 额外给 `failure.at` /
  `failure.stale`（失败是否早于最近一次成功检查），面板遇到旧失败只折叠成一行「历史失败记录（含
  时间）」，成功结果照常显示。三种时序都验过：失败晚于检查→报警，检查晚于失败→折叠，
  从未检查过→报警。
- 排查提示：`Failed to connect to github.com port 443 after 21102 ms` 这种「刚好 21 秒」的超时，
  是**直连**的特征耗时；走 Clash 正常约 1.2 秒。看到 21 秒就说明这一趟没走代理（或代理没起来），
  据此可立刻区分「代理没生效」和「代理起来了但节点不通」。

### 0.1.6

- **检查失败时给出可执行的诊断**：以前只把 git 的原始报错贴出来，而
  `error: cannot open '.git/FETCH_HEAD': Permission denied` 里的 "Permission denied" 极易被读成
  「远端拒了我 / SSH 密钥不对」，实际是**本机写文件被拒**（Windows 上最常见是只读属性）。现在会先
  探测 `.git` 下 `FETCH_HEAD`/`HEAD`/`index`/`refs/**` 是否可写，命中就直接报出具体是哪个文件不可写，
  并给出 `attrib -R` 修复命令；同时区分 SSH 无密钥、凭据缺失、仓库不存在、DNS、连不上这几类，
  各给各的修法。端到端实测：把 `FETCH_HEAD` 设成只读 → 面板直接点名该文件 + 修复命令；
  `attrib -R` 之后同一次检查恢复正常。

### 0.1.5

- **修「工作区永远有改动」的误判**：`git status --porcelain` 的行是 `XY<空格>路径`，未暂存项
  （` M file`）**行首就是一个空格**。旧代码对整个输出 `.trim()`，吃掉那个空格后路径整体左移一位，
  于是被 `regenerateTracked` 匹配不到、明明配置了仍报「有未提交改动」。现在按行解析、只丢空行，
  并同时兼容 CRLF。
- 新增 `regenerateTracked`：列出「每次启动会被钩子重写」的已跟踪文件（如本机的
  `packages/bundle/web-app/presets/*.patch.yml`）。切换前只丢弃这些文件的本地改动并记录在
  步骤的 `discarded` 里，真正的用户改动仍然拦住更新。不配置时行为不变（全算阻塞）。

### 0.1.4

- **支持系统代理**：新增 `proxy`（默认 `auto`）。每次调用读
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable`/`ProxyServer`，
  把代理以 `HTTP(S)_PROXY` 注入 git 与 pnpm。原因：git/libcurl 在 Windows 上**不使用**系统代理，
  所以 Clash Verge 这类只开系统代理的工具会让 git 直连并报
  `unable to access ... Failed to connect to github.com port 443`；Steam++ 改的是 hosts，因此看起来
  「能识别」。实测：不注入 21.3s 后失败，注入后 2.0s 成功。改了代理无需重启插件（每次读一次）。
- 面板新增一行「网络：…」，直接显示当前用的代理或「直连」，把这类失败和插件本身的故障分开。
- 「工作区有未提交改动」的暂停提示现在给出三条可执行的处理办法（stash / 丢弃生成物 / 提交），
  而不是只报一句「已暂停」。

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
