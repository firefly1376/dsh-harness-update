/**
 * dsh-harness-update — host half.
 *
 * Self-update for DeepSeek Harness git-source installs: version check, one-click
 * update (fetch / checkout -> install -> clean -> build) and rollback, driven
 * from the settings row rendered by the browser half.
 *
 * Deliberate decisions behind this file:
 *   1. Windows shims: pnpm/npm are .cmd files, and Node cannot spawn a .cmd
 *      directly (execFile yields ENOENT in a few ms with empty output). Every
 *      command here is resolved through PATH+PATHEXT, and .cmd/.bat files are
 *      launched through the ComSpec launcher (/d /s /c).
 *   2. Diagnosability: a step always records its merged output tail, and a
 *      failure to even start the process records the spawn error, so a failed
 *      step never again shows up as "failed" with an empty tail.
 *   3. The check is channel-based, not commit-based. "release" (default) reads
 *      the newest official release tag (dsh-v*, stable or rc line); "branch"
 *      keeps the old behaviour of following origin/<branch>. Comparing commit
 *      counts across those two lines is meaningless — a release tag is cut from
 *      an older master point — so the release channel compares version strings.
 *   4. check() never blocks the HTTP request: it returns immediately and the
 *      work continues in the background, because a slow `git fetch` used to
 *      blow through the browser half's 15s request timeout and be reported as a
 *      failure while it was still running (and a second click then raced the
 *      first one on refs/remotes/*).
 */
import { spawn, execFileSync } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, join, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'harness-update'

/** Services required by this plugin. */
export const inject = []

/** Where the host routes are mounted (the browser half uses the same prefix). */
const ROUTE_PREFIX = '/harness-update/api'

/** Default budget for one long step (install / clean / build). */
const STEP_TIMEOUT_MS = 1800000

/** Default budget for git fetch / git pull. */
const FETCH_TIMEOUT_MS = 900000

/** Bytes of merged output kept per step. */
const TAIL_LIMIT = 6000

/** Tag namespace used by the official DSH releases. */
const RELEASE_TAG_PREFIX = 'dsh-v'

/** Bumped when the persisted state shape changes; older caches are dropped. */
const STATE_VERSION = 2

/** ComSpec launcher used for .cmd/.bat shims. */
const COMSPEC = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'

const IS_WIN = process.platform === 'win32'

/** Keep the last slice of a text blob. */
function tailOf(text, limit) {
  const value = String(text === undefined || text === null ? '' : text)
  const max = limit || TAIL_LIMIT
  return value.length <= max ? value : value.slice(value.length - max)
}

/** Current timestamp in ISO form. */
function nowIso() {
  return new Date().toISOString()
}

/**
 * Parse a semver string into its comparable parts.
 * @param text - version like "0.2.1-rc.5".
 * @returns parsed parts, or undefined when the string is not semver.
 */
function parseVersion(text) {
  const matched = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text === undefined || text === null ? '' : text).trim())
  if (!matched) return undefined
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    prerelease: matched[4] ? matched[4].split('.') : [],
    raw: String(text).trim(),
  }
}

/**
 * Compare two version strings (semver precedence, prerelease included).
 * @returns 1 when a is newer, -1 when b is newer, 0 when equal or unparsable.
 */
function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a
  const right = typeof b === 'string' ? parseVersion(b) : b
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0
  if (!left.prerelease.length) return 1
  if (!right.prerelease.length) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const x = left.prerelease[i]
    const y = right.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1
      continue
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * Whether a version belongs to the released line: stable, or an rc prerelease.
 * Alpha/beta snapshots are development builds and are never offered.
 */
function isReleaseVersion(text) {
  const parsed = parseVersion(text)
  if (!parsed) return false
  if (!parsed.prerelease.length) return true
  return /^rc(?:\.\d+)?$/.test(parsed.prerelease.join('.'))
}

/** Normalise a proxy value into a URL; a bare `host:port` becomes http://host:port. */
function toProxyUrl(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (!text) return undefined
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text
}

/**
 * Read the Windows system (WinINET) proxy, the setting the Settings app and
 * Clash Verge write. Node and git both ignore it: libcurl on Windows has no
 * "read the system proxy" build step, so a git spawned here connects directly
 * unless a proxy is handed to it explicitly. Steam++-style accelerators hide
 * this by rewriting the hosts file instead of proxying, which is why switching
 * accelerators changes the outcome with no code change here.
 * @returns the proxy URL, or undefined when Windows has no proxy enabled.
 */
function windowsSystemProxy() {
  if (!IS_WIN) return undefined
  let out = ''
  try {
    out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
      encoding: 'utf8',
      windowsHide: true,
    })
  } catch (err) {
    return undefined
  }
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out)
  if (!enabled || Number('0x' + enabled[1]) === 0) return undefined
  const server = /ProxyServer\s+REG_SZ\s+(.+)/.exec(out)
  if (!server) return undefined
  const raw = server[1].trim()
  // Either "host:port" for everything, or "http=host:port;https=host:port;...".
  if (!raw.includes('=')) return toProxyUrl(raw)
  const map = {}
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) map[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim()
  }
  return toProxyUrl(map.https || map.http || '')
}

/** Proxy variables in both spellings: libcurl reads lowercase, some tools only uppercase. */
function proxyEnv(proxy) {
  if (!proxy) return {}
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  }
}

/**
 * Resolve a command name to a real file, honouring PATHEXT on Windows.
 * @param command - bare command name or an explicit path.
 * @returns the resolved path, or undefined when nothing matched.
 */
function resolveCommand(command) {
  if (!command) return undefined
  if (command.includes('/') || command.includes('\\')) return existsSync(command) ? command : undefined
  const exts = IS_WIN
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    if (!IS_WIN) {
      const direct = join(dir, command)
      if (existsSync(direct)) return direct
      continue
    }
    // Windows: a bare name in PATH is usually a POSIX shell script (pnpm's
    // .bin shim); only extension-suffixed files are launchable.
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase())
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** Quote one argument for a cmd.exe command line. */
function quoteForCmd(arg) {
  const value = String(arg)
  if (!/[\s"&|<>^()]/.test(value)) return value
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"'
}

/** Build the ComSpec argv for one command line. */
function cmdInvocation(file, args) {
  const line = [file].concat(args).map(quoteForCmd).join(' ')
  return /\s/.test(line) ? ['/d', '/s', '/c', '"' + line + '"'] : ['/d', '/s', '/c', line]
}

/**
 * Run one command and capture its merged output.
 * @param file - command name or path.
 * @param args - argument vector.
 * @param options - cwd, timeoutMs, tailLimit, proxy, env.
 * @returns code, signal, spawnError, tail, ms, resolved, viaComspec.
 */
function runCommand(file, args, options) {
  const opts = options || {}
  const started = Date.now()
  const resolved = resolveCommand(file) || file
  const ext = (extname(resolved) || '').toLowerCase()
  const viaComspec = IS_WIN && (ext === '.cmd' || ext === '.bat')
  const cmd = viaComspec ? COMSPEC : resolved
  const cmdArgs = viaComspec ? cmdInvocation(resolved, args) : args
  return new Promise((settle) => {
    let out = ''
    let done = false
    let child
    const budget = opts.timeoutMs || STEP_TIMEOUT_MS
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const note = result.note ? '\n' + result.note : ''
      settle({
        code: result.code === undefined ? null : result.code,
        signal: result.signal === undefined ? null : result.signal,
        spawnError: result.spawnError,
        tail: tailOf(out + note, opts.tailLimit || TAIL_LIMIT),
        ms: Date.now() - started,
        resolved,
        viaComspec,
      })
    }
    const timer = setTimeout(() => {
      try { if (child) child.kill() } catch (err) { /* already gone */ }
      finish({ code: null, signal: 'timeout', note: '超时 ' + budget + ' ms，已终止该步骤' })
    }, budget)
    try {
      child = spawn(cmd, cmdArgs, {
        cwd: opts.cwd,
        env: Object.assign({}, process.env, proxyEnv(opts.proxy), opts.env || {}, { CI: '1' }),
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: viaComspec,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      finish({ code: null, spawnError: String(err && err.code ? err.code : err), note: '无法启动 ' + cmd + ': ' + String(err) })
      return
    }
    if (child.stdout) child.stdout.on('data', (chunk) => { out += String(chunk) })
    if (child.stderr) child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('error', (err) => {
      const code = err && err.code ? err.code : String(err)
      finish({ code: null, spawnError: code, note: '无法启动 ' + cmd + ': ' + code })
    })
    child.on('close', (code, signal) => finish({ code, signal }))
  })
}

/** Run git synchronously for status reads (never throws). */
function gitSync(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
  } catch (err) {
    return ''
  }
}

/**
 * Find the DSH checkout to update when the config does not pin one:
 * DSH_REPO_ROOT, then the checkout that owns the running apps/cli entry, then cwd.
 */
function detectRepoRoot() {
  const candidates = [process.env.DSH_REPO_ROOT, argvRoot(), process.cwd()]
  for (const candidate of candidates) {
    if (!candidate) continue
    const root = resolve(candidate)
    if (existsSync(join(root, 'package.json')) && existsSync(join(root, 'apps', 'cli'))) return root
  }
  return resolve(process.cwd())
}

/** Checkout root implied by the running entry: apps/cli/src/bin.ts -> three levels up. */
function argvRoot() {
  const entry = process.argv[1]
  return entry ? resolve(dirname(entry), '..', '..', '..') : undefined
}

/**
 * Split `git status --porcelain` output into entries.
 *
 * Never trim the whole blob first: a porcelain line is `XY<space>path`, so the
 * first character of an unstaged entry IS a space (` M file`). Trimming the blob
 * eats that space and shifts the path by one character, which made a modified
 * file look unrecognised and unclassified. Only whole-blank lines are dropped.
 */
function porcelainLines(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim().length > 0 && line.length > 3)
}

/** Drop untracked entries: they never block a checkout, and listing them as a blocker was wrong. */
function trackedChanges(porcelainText) {
  return porcelainLines(porcelainText)
    .filter((line) => !line.startsWith('??'))
    .join('\n')
}

/**
 * Refuse a checkout while tracked files are modified, and say how to clear it:
 * a bare "有未提交改动" leaves the user to guess, and on this kind of install the
 * usual offender is a generated file that a postinstall hook rewrites anyway.
 */
function blockedMessage(trackedText) {
  return '工作区有未提交的已跟踪改动，已暂停更新：\n' + tailOf(trackedText, 2000)
    + '\n\n处理方式（择一）：\n'
    + '  git stash --include-untracked     保留改动并清空工作区，更新后可 git stash pop\n'
    + '  git checkout -- <上面列出的文件>   丢弃改动（由钩子生成的文件会在 install 后重新生成）\n'
    + '  git commit -am "本地改动"          确实要保留时先提交\n'
    + '  若这些文件每次启动都会被钩子重写，把它们写进配置 regenerateTracked，'
    + '插件会在切换前丢弃这些文件的本地改动'
}

/**
 * Turn a failed fetch into something the user can act on.
 *
 * The plugin spawns git with `stdio: ['ignore', 'pipe', 'pipe']`, so a
 * credential prompt has no terminal to appear on: git either fails outright or
 * waits forever. Both end up looking like a generic "fetch 失败", and the three
 * causes here need entirely different fixes, so name the one that matches.
 * @param tail - merged stderr/stdout of the failed command.
 * @param remoteUrl - the resolved remote URL, used to tell SSH from HTTPS.
 * @param unwritable - local .git files the caller proved unwritable.
 * @returns a short diagnosis, or undefined when nothing matches.
 */
function diagnoseFetchError(tail, remoteUrl, unwritable) {
  const text = String(tail || '')
  const url = String(remoteUrl || '')
  // A local write refusal must be named before any remote-side guess: the
  // message contains "Permission denied" too, and blaming SSH for it sends the
  // user off to regenerate keys that were never the problem.
  if (Array.isArray(unwritable) && unwritable.length > 0) {
    return '不是网络也不是远端账号问题：本机 .git 里有文件不可写 —— ' + unwritable.join('、')
      + '。Windows 上最常见是「只读」属性。修复：attrib -R "' + unwritable[0] + '"'
      + '（多个就逐个执行，或对 .git 目录递归 attrib -R /S /D）。改完再点「检查更新」'
  }
  if (/cannot open '?\.git\//i.test(text) && /Permission denied/i.test(text)) {
    const file = /cannot open '?([^':]+)'?: Permission denied/i.exec(text)
    return '不是网络问题：git 无法写本机的 ' + (file ? file[1] : '.git 里的文件')
      + '。多半是只读属性或被其他进程占用；在检出目录执行 attrib -R /S /D .git 后重试'
  }
  if (/Permission denied \(publickey\)|Host key verification failed|could not read from remote repository|Could not read from remote repository/i.test(text)) {
    const viaSsh = /^[^@/\s]+@[^:]+:/i.test(url) || /^ssh:\/\//i.test(url)
    return (viaSsh ? '远端是 SSH 地址（' + url + '），但这台机器没有可用的 SSH 密钥，git 因此被拒。' : '远端鉴权被拒。')
      + '两条路：① 把远端改成 HTTPS —— git remote set-url ' + 'origin https://github.com/deepseek-ai/deepseek-harness.git'
      + '；② 配好 SSH 密钥（ssh -T git@github.com 能通过）。改完再点「检查更新」'
  }
  if (/Permission denied/i.test(text)) {
    return '权限被拒：若不是 SSH 密钥问题，检查仓库目录与 .git 的读写权限（Windows 上另见只读属性/ACL），以及该账号能否访问远端'
  }
  if (/terminal prompts disabled|Authentication failed|could not read Username|Invalid username or password/i.test(text)) {
    return '远端要求登录，但插件没有交互终端可以输入：改用公开的 HTTPS 地址，或用已配置好凭据的凭据管理器（git config credential.helper）'
  }
  if (/Repository not found|does not appear to be a git repository|404/i.test(text)) {
    return '远端不存在或当前账号无权访问（' + (url || 'remote') + '）：核对地址，私有仓库还需要有效凭据'
  }
  if (/Could not resolve host|Name or service not known/i.test(text)) {
    return '域名解析失败：这台机器的网络/DNS 或代理不通，打开加速器或代理后重试'
  }
  if (/Failed to connect|Connection (was )?reset|Connection timed out|Operation timed out/i.test(text)) {
    return '连不上远端：网络或代理不通。若开了代理，确认它是「系统代理」模式且面板「网络：」那行显示的地址可用；'
      + 'git 不读 Windows 系统代理以外的任何设置，插件已按系统代理注入，仍需该代理本身能出网'
  }
  return undefined
}

/**
 * Find git index/ref files that are not writable.
 *
 * `error: cannot open '.git/FETCH_HEAD': Permission denied` is not a network
 * problem and not a remote-authentication problem — it is a local write being
 * refused, and the usual Windows cause is the read-only attribute (a file
 * copied from a read-only medium, or restored by a backup that preserved it).
 * Naming the exact file turns a dead end into a one-line fix.
 * @param gitDir - the repository's .git directory.
 * @returns the unwritable paths, empty when everything is writeable.
 */
function findUnwritableGitFiles(gitDir) {
  const targets = [
    'FETCH_HEAD', 'HEAD', 'ORIG_HEAD', 'index',
    join('refs', 'heads'), join('refs', 'remotes'), join('refs', 'tags'),
  ]
  const bad = []
  const probe = (path) => {
    try {
      accessSync(path, fsConstants.W_OK)
    } catch (err) {
      // ENOENT is fine: git creates these on demand.
      if (err && err.code !== 'ENOENT') bad.push(path)
    }
  }
  for (const target of targets) {
    const full = join(gitDir, target)
    if (!existsSync(full)) continue
    let stat
    try { stat = statSync(full) } catch (err) { continue }
    if (stat.isDirectory()) {
      // A directory's own flag blocks creating any entry inside it, but each
      // existing ref file carries its own attribute too.
      probe(full)
      try {
        for (const entry of readdirSync(full)) probe(join(full, entry))
      } catch (err) { /* unreadable directory is already reported by probe */ }
    } else {
      probe(full)
    }
  }
  return bad
}

/** Match one repo-relative path against a `*`-glob from config (no `**`, no char classes). */
function matchesPathPattern(path, pattern) {
  const value = String(pattern || '').replace(/\\/g, '/')
  if (!value) return false
  if (!value.includes('*')) return path === value
  const rx = new RegExp('^' + value.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
  return rx.test(path)
}

/**
 * Split modified tracked files into "blocking" and "regenerated".
 * A path listed in `regenerateTracked` is rewritten by an install/boot hook, so
 * its local modification is not real work and discarding it is safe.
 */
function classifyTracked(trackedText, regeneratePatterns) {
  const patterns = regeneratePatterns || []
  const blocking = []
  const regenerated = []
  for (const line of String(trackedText || '').split('\n')) {
    if (!line.trim()) continue
    // Porcelain v1: two status columns, a space, then the path (may be quoted).
    const path = line.slice(3).replace(/^"|"$/g, '').trim()
    if (patterns.some((pattern) => matchesPathPattern(path, pattern))) regenerated.push(path)
    else blocking.push(line)
  }
  return { blocking: blocking.join('\n'), regenerated }
}

/**
 * Build the updater bound to one config.
 * @param config - plugin config: repoRoot, remote, branch, channel, tagPrefix,
 *   pnpmCommand, stateFile, proxy, timeouts.
 */
function createUpdater(config) {
  const opts = config || {}
  const repoRoot = opts.repoRoot || detectRepoRoot()
  const remote = opts.remote || 'origin'
  const branch = opts.branch || 'master'
  const channel = opts.channel === 'branch' ? 'branch' : 'release'
  const tagPrefix = opts.tagPrefix || RELEASE_TAG_PREFIX
  const pnpmCommand = opts.pnpmCommand || 'pnpm'
  const stateFile = opts.stateFile || join(homedir(), '.dsh-harness-update', 'state.json')
  const checkTimeoutMs = opts.checkTimeoutMs || FETCH_TIMEOUT_MS
  const stepTimeoutMs = opts.stepTimeoutMs || STEP_TIMEOUT_MS
  // Tracked files that a boot/install hook rewrites on every run. Their local
  // modification is not user work, so the checkout discards it instead of
  // stalling — a stale entry here is safe (it just restores a generated file).
  const regenerateTracked = Array.isArray(opts.regenerateTracked) ? opts.regenerateTracked : []
  // "auto" (default) reads the Windows system proxy at call time, so switching
  // an accelerator on later does not need a plugin restart. "none" disables it,
  // and any other value is used verbatim (http://host:port).
  const proxySetting = opts.proxy === undefined ? 'auto' : opts.proxy
  const resolveProxy = () => {
    if (proxySetting === 'none' || proxySetting === false) return { proxy: undefined, source: 'disabled' }
    if (proxySetting === 'auto' || proxySetting === true) {
      const found = windowsSystemProxy()
      return found ? { proxy: found, source: 'system' } : { proxy: undefined, source: 'none' }
    }
    return { proxy: toProxyUrl(proxySetting), source: 'config' }
  }
  const state = {
    stateVersion: STATE_VERSION,
    phase: 'idle',
    steps: [],
    channel,
    checking: false,
    checkStatus: 'never',
    lastCheckedAt: undefined,
    lastError: undefined,
    previousSha: undefined,
    restartRequired: false,
    available: undefined,
    dirty: undefined,
    bootSha: gitSync(repoRoot, ['rev-parse', 'HEAD']),
  }

  const persist = () => {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = stateFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, stateFile)
    } catch (err) { /* state persistence is best effort */ }
  }

  const restore = () => {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
      const interrupted = !!(saved && saved.phase === 'running')
      if (interrupted) {
        saved.phase = 'failed'
        saved.lastError = '上一次更新被中断（进程已退出）'
        for (const step of saved.steps || []) {
          if (step.state === 'running' || step.state === 'pending') step.state = 'failed'
        }
      }
      Object.assign(state, saved, { bootSha: state.bootSha, stateVersion: STATE_VERSION, channel })
      // A cached answer from another channel (or from the old master-only shape)
      // says nothing about what is available on the channel actually in force, and
      // neither does the failure text recorded by the code path it replaced: keep
      // it and the first look after an upgrade reports a failure that cannot recur.
      if (saved.stateVersion !== STATE_VERSION || (saved.available && saved.available.channel !== channel)) {
        state.available = undefined
        state.checkStatus = 'never'
        delete state.checkDebug
        if (!interrupted) state.lastError = undefined
      }
      // No check can survive the process that ran it.
      state.checking = false
    } catch (err) { /* no previous state */ }
  }

  const readVersion = () => {
    try {
      return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
    } catch (err) {
      return undefined
    }
  }

  /** Resolved remote URL, or a hint when it is missing (a broken origin explains most permission errors). */
  const remoteUrl = () => {
    const url = gitSync(repoRoot, ['remote', 'get-url', remote])
    return url || ''
  }

  /** Absolute .git directory (a worktree or submodule points elsewhere, hence --git-dir). */
  const gitDir = () => {
    const dir = gitSync(repoRoot, ['rev-parse', '--absolute-git-dir'])
    return dir || join(repoRoot, '.git')
  }

  const git = (args, timeoutMs, tailLimit) =>
    runCommand('git', args, { cwd: repoRoot, timeoutMs: timeoutMs || 120000, tailLimit, proxy: resolveProxy().proxy })

  // The running code is the boot SHA; anything else on disk needs a restart.
  let shaCache = { at: 0, sha: '' }
  const headSha = () => {
    const at = Date.now()
    if (at - shaCache.at > 2000) shaCache = { at, sha: gitSync(repoRoot, ['rev-parse', 'HEAD']) }
    return shaCache.sha
  }

  const status = () => {
    const resolved = resolveProxy()
    // A failed pipeline run stays in `phase: failed` until the next run, so its
    // output would otherwise be replayed forever as if it just happened. Report
    // when it failed and whether a later check has since succeeded, so the
    // browser half can label it instead of presenting it as the current result.
    const failedStep = (state.steps || []).filter((step) => step && step.state === 'failed')[0]
    const failureAt = failedStep && (failedStep.endedAt || failedStep.startedAt)
    const checkIsNewer = !!(failureAt && state.lastCheckedAt && Date.parse(state.lastCheckedAt) > Date.parse(failureAt))
    return {
    phase: state.phase,
    steps: state.steps,
    channel,
    checking: state.checking,
    checkStatus: state.checkStatus,
    lastCheckedAt: state.lastCheckedAt,
    lastError: state.lastError,
    previousSha: state.previousSha,
    restartRequired: state.restartRequired && headSha() !== state.bootSha,
    available: state.available,
    dirty: state.dirty,
    regenerated: state.regenerated,
    failure: failureAt ? { at: failureAt, step: failedStep.label, stale: checkIsNewer } : undefined,
    runtime: {
      sha: headSha(),
      shortSha: gitSync(repoRoot, ['rev-parse', '--short', 'HEAD']),
      bootSha: state.bootSha,
      branch: gitSync(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
      version: readVersion(),
      stale: headSha() !== state.bootSha,
      platform: process.platform,
      node: process.version,
    },
    probe: {
      repoRoot, remote, branch, channel, tagPrefix,
      pnpm: resolveCommand(pnpmCommand) || pnpmCommand,
      proxy: resolved.proxy,
      proxySource: resolved.source,
    },
    }
  }

  /** Record which files are dirty; returns only the changes that really block an update. */
  const scanDirty = async () => {
    const text = (await git(['status', '--porcelain'], 120000)).tail
    state.dirty = text ? text.split('\n').slice(0, 20) : []
    const split = classifyTracked(trackedChanges(text), regenerateTracked)
    state.regenerated = split.regenerated
    return split.blocking
  }

  /** Compose the message for a failed network step, with a diagnosis when one fits. */
  const fetchFailure = (result, label) => {
    const tail = tailOf(result.tail).trim()
    const guess = diagnoseFetchError(tail, remoteUrl(), findUnwritableGitFiles(gitDir()))
    return (label || 'git fetch --tags') + ' 失败：' + (tail || '未知错误')
      + (guess ? '\n\n可能原因与处理：' + guess : '')
  }

  /** release channel: newest official release tag wins by version string. */
  const checkRelease = async () => {
    const fetched = await git(['fetch', '--quiet', '--tags', '--force', remote], checkTimeoutMs)
    if (fetched.code !== 0) {
      state.checkStatus = 'failed'
      state.lastError = fetchFailure(fetched)
      return
    }
    const listed = await git(['tag', '--list', tagPrefix + '*'], 60000)
    let best
    for (const raw of listed.tail.split('\n')) {
      const tag = raw.trim()
      if (!tag || !tag.startsWith(tagPrefix)) continue
      const version = tag.slice(tagPrefix.length)
      if (!isReleaseVersion(version)) continue
      if (!best || compareVersions(version, best.version) > 0) best = { tag, version }
    }
    state.checkDebug = { fetchCode: fetched.code, latestTag: best ? best.tag : undefined }
    const current = readVersion()
    state.currentVersion = current
    if (!best || compareVersions(best.version, current) <= 0) {
      state.checkStatus = 'ok'
      state.available = undefined
      return
    }
    const sha = gitSync(repoRoot, ['rev-parse', best.tag + '^{commit}'])
    // A...B -> left counts what only HEAD has (ahead), right what only B has (behind).
    const counts = sha ? gitSync(repoRoot, ['rev-list', '--left-right', '--count', 'HEAD...' + sha]).split(/\s+/) : []
    state.available = {
      channel: 'release',
      version: best.version,
      tag: best.tag,
      sha,
      target: best.tag,
      current,
      ahead: Number(counts[0]) || 0,
      behind: Number(counts[1]) || 0,
    }
    state.checkStatus = 'ok'
  }

  /** branch channel: the historical origin/<branch> comparison. */
  const checkBranch = async () => {
    const target = remote + '/' + branch
    const fetched = await git(['fetch', '--quiet', remote, branch], checkTimeoutMs)
    if (fetched.code !== 0) {
      state.checkStatus = 'failed'
      state.lastError = fetchFailure(fetched, 'git fetch')
      return
    }
    const behindText = (await git(['rev-list', '--count', 'HEAD..' + target], 120000)).tail.trim()
    const behind = Number(behindText)
    const show = await git(['show', target + ':package.json'], 120000, 1200000)
    let version
    if (show.code === 0) {
      const matched = /"version"[\s]*:[\s]*"([^"]+)"/.exec(show.tail)
      version = matched ? matched[1] : undefined
    }
    state.checkDebug = { fetchCode: fetched.code, showCode: show.code, showBytes: show.tail.length, behindRaw: behindText }
    if (version === undefined && show.code === 0) {
      try { version = JSON.parse(show.tail).version } catch (err) { version = undefined }
    }
    state.checkStatus = 'ok'
    state.available = Number.isFinite(behind) && behind > 0
      ? { channel: 'branch', behind, version, current: readVersion(), sha: gitSync(repoRoot, ['rev-parse', target]), target }
      : undefined
  }

  let checkInFlight = null

  /**
   * Start a check and return at once: the browser half polls /status for the
   * result. Re-entrant calls are no-ops, which is what keeps two clicks from
   * racing the same refs on the git side.
   */
  const check = () => {
    if (checkInFlight) return status()
    state.checking = true
    state.lastError = undefined
    persist()
    checkInFlight = scanDirty()
      .then((tracked) => {
        if (tracked) {
          state.checkStatus = 'failed'
          state.lastError = '工作区有未提交的已跟踪改动，检查仍按远端进行，但更新会被暂停'
        }
        return channel === 'release' ? checkRelease() : checkBranch()
      })
      .catch((err) => {
        state.checkStatus = 'failed'
        state.lastError = '检查更新出错：' + String(err && err.message ? err.message : err)
      })
      .then(() => {
        checkInFlight = null
        state.checking = false
        state.lastCheckedAt = nowIso()
        persist()
      })
    return status()
  }

  const busy = () => state.phase === 'running'

  const stepsFor = (mode) => {
    const list = []
    if (mode === 'rollback') {
      list.push({ id: 'reset', label: '回滚源码 (git reset --hard)' })
    } else if (channel === 'release') {
      list.push({ id: 'fetch', label: '拉取发布标签 (git fetch --tags)' })
      list.push({ id: 'checkout', label: '切换到发布版 (git checkout --detach)' })
    } else {
      list.push({ id: 'pull', label: '拉取源码 (git pull --ff-only)' })
    }
    list.push({ id: 'install', label: '安装依赖 (pnpm install)' })
    list.push({ id: 'clean', label: '清理构建产物 (pnpm clean)' })
    list.push({ id: 'build', label: '构建 (pnpm build:official)' })
    return list
  }

  const runPipeline = async (mode, resetSha) => {
    const steps = stepsFor(mode)
    const releaseTag = state.available && state.available.tag
    state.phase = 'running'
    state.restartRequired = false
    state.lastError = undefined
    state.steps = steps.map((step) => ({ id: step.id, label: step.label, state: 'pending' }))
    persist()
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]
      const slot = state.steps[i]
      Object.assign(slot, { state: 'running', startedAt: nowIso() })
      persist()
      // Network steps get the same proxy the check used; pnpm needs it too
      // (registry + tarball fetches), local git steps simply ignore it.
      const netProxy = resolveProxy().proxy
      let result
      if (step.id === 'pull') {
        const blocked = trackedChanges((await git(['status', '--porcelain'], 120000)).tail)
        if (blocked) {
          result = { code: 1, tail: blockedMessage(blocked), ms: 0, spawnError: undefined }
        } else {
          state.previousSha = gitSync(repoRoot, ['rev-parse', 'HEAD'])
          result = await runCommand('git', ['pull', '--ff-only', remote, branch], { cwd: repoRoot, timeoutMs: checkTimeoutMs, proxy: netProxy })
        }
      } else if (step.id === 'fetch') {
        result = await runCommand('git', ['fetch', '--quiet', '--tags', '--force', remote], { cwd: repoRoot, timeoutMs: checkTimeoutMs, proxy: netProxy })
      } else if (step.id === 'checkout') {
        const tracked = trackedChanges((await git(['status', '--porcelain'], 120000)).tail)
        const split = classifyTracked(tracked, regenerateTracked)
        // Files a hook regenerates on every boot carry no real work: drop their
        // local modification so the checkout can proceed instead of stalling.
        if (split.regenerated.length > 0) {
          await runCommand('git', ['checkout', '--'].concat(split.regenerated), { cwd: repoRoot, timeoutMs: checkTimeoutMs, proxy: netProxy })
          slot.discarded = split.regenerated
        }
        if (split.blocking) {
          result = { code: 1, tail: blockedMessage(split.blocking), ms: 0, spawnError: undefined }
        } else if (!releaseTag) {
          result = { code: 1, tail: '没有目标发布 tag：请先点「检查更新」', ms: 0, spawnError: undefined }
        } else {
          state.previousSha = gitSync(repoRoot, ['rev-parse', 'HEAD'])
          result = await runCommand('git', ['-c', 'advice.detachedHead=false', 'checkout', '--detach', releaseTag], { cwd: repoRoot, timeoutMs: checkTimeoutMs, proxy: netProxy })
        }
      } else if (step.id === 'reset') {
        state.previousSha = gitSync(repoRoot, ['rev-parse', 'HEAD'])
        result = await runCommand('git', ['reset', '--hard', resetSha], { cwd: repoRoot, timeoutMs: checkTimeoutMs, proxy: netProxy })
      } else if (step.id === 'install') {
        result = await runCommand(pnpmCommand, ['install', '--frozen-lockfile'], { cwd: repoRoot, timeoutMs: stepTimeoutMs, proxy: netProxy })
      } else if (step.id === 'clean') {
        result = await runCommand(pnpmCommand, ['clean'], { cwd: repoRoot, timeoutMs: stepTimeoutMs, proxy: netProxy })
      } else {
        result = await runCommand(pnpmCommand, ['build:official'], { cwd: repoRoot, timeoutMs: stepTimeoutMs, proxy: netProxy })
      }
      const ok = result.code === 0
      Object.assign(slot, {
        state: ok ? 'ok' : 'failed',
        endedAt: nowIso(),
        exitCode: result.code,
        ms: result.ms,
        tail: result.tail,
      })
      if (!ok) {
        state.phase = 'failed'
        state.lastError = step.label + ' 失败' + (result.spawnError ? '（' + result.spawnError + '）' : '')
        persist()
        return false
      }
      persist()
    }
    state.phase = 'done'
    state.restartRequired = true
    state.available = undefined
    persist()
    return true
  }

  const install = async () => {
    if (busy()) return status()
    await runPipeline('install')
    return status()
  }

  const rollback = async (sha) => {
    if (busy()) return status()
    const target = sha || state.previousSha
    if (!target) {
      state.phase = 'failed'
      state.lastError = '没有可回滚的目标提交'
      persist()
      return status()
    }
    await runPipeline('rollback', target)
    return status()
  }

  restore()
  return { status, check, install, rollback, state }
}

/**
 * Mount the self-update routes.
 * @param ctx - host root context.
 * @param config - plugin config.
 */
export const __internals = {
  resolveCommand,
  runCommand,
  tailOf,
  trackedChanges,
  porcelainLines,
  classifyTracked,
  matchesPathPattern,
  blockedMessage,
  diagnoseFetchError,
  findUnwritableGitFiles,
  parseVersion,
  compareVersions,
  isReleaseVersion,
  toProxyUrl,
  windowsSystemProxy,
  proxyEnv,
  createUpdater,
}

export function apply(ctx, config) {
  const updater = createUpdater(config || {})
  ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => webCtx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const send = (payload, code) => {
        res.statusCode = code || 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(payload))
      }
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const route = url.pathname.slice(ROUTE_PREFIX.length)
        if (req.method === 'GET' && route === '/status') return send(updater.status())
        if (req.method === 'POST' && route === '/check') return send(updater.check())
        if (req.method === 'POST' && route === '/install') {
          updater.install().catch(() => {})
          return send(updater.status())
        }
        if (req.method === 'POST' && route === '/rollback') {
          updater.rollback(url.searchParams.get('sha') || undefined).catch(() => {})
          return send(updater.status())
        }
        return send({ error: 'not found', route }, 404)
      } catch (err) {
        return send({ error: String(err) }, 500)
      }
    }
  }), 'dsh-harness-update: routes'))
}