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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
 * @param options - cwd, timeoutMs, tailLimit.
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
        env: Object.assign({}, process.env, { CI: '1' }),
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

/** Drop untracked entries: they never block a checkout, and listing them as a blocker was wrong. */
function trackedChanges(porcelainText) {
  return String(porcelainText || '')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('??'))
    .join('\n')
}

/**
 * Build the updater bound to one config.
 * @param config - plugin config: repoRoot, remote, branch, channel, tagPrefix,
 *   pnpmCommand, stateFile, timeouts.
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

  const git = (args, timeoutMs, tailLimit) =>
    runCommand('git', args, { cwd: repoRoot, timeoutMs: timeoutMs || 120000, tailLimit })

  // The running code is the boot SHA; anything else on disk needs a restart.
  let shaCache = { at: 0, sha: '' }
  const headSha = () => {
    const at = Date.now()
    if (at - shaCache.at > 2000) shaCache = { at, sha: gitSync(repoRoot, ['rev-parse', 'HEAD']) }
    return shaCache.sha
  }

  const status = () => ({
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
    probe: { repoRoot, remote, branch, channel, tagPrefix, pnpm: resolveCommand(pnpmCommand) || pnpmCommand },
  })

  /** Record which files are dirty; returns the tracked-only subset as a gate. */
  const scanDirty = async () => {
    const text = (await git(['status', '--porcelain'], 120000)).tail.trim()
    state.dirty = text ? text.split('\n').slice(0, 20) : []
    return trackedChanges(text)
  }

  /** release channel: newest official release tag wins by version string. */
  const checkRelease = async () => {
    const fetched = await git(['fetch', '--quiet', '--tags', '--force', remote], checkTimeoutMs)
    if (fetched.code !== 0) {
      state.checkStatus = 'failed'
      state.lastError = 'git fetch --tags 失败：' + (tailOf(fetched.tail).trim() || '未知错误')
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
      state.lastError = 'git fetch 失败：' + (tailOf(fetched.tail).trim() || '未知错误')
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
      let result
      if (step.id === 'pull') {
        const blocked = trackedChanges((await git(['status', '--porcelain'], 120000)).tail.trim())
        if (blocked) {
          result = { code: 1, tail: '工作区有未提交改动，已暂停更新：\n' + tailOf(blocked, 2000), ms: 0, spawnError: undefined }
        } else {
          state.previousSha = gitSync(repoRoot, ['rev-parse', 'HEAD'])
          result = await runCommand('git', ['pull', '--ff-only', remote, branch], { cwd: repoRoot, timeoutMs: checkTimeoutMs })
        }
      } else if (step.id === 'fetch') {
        result = await runCommand('git', ['fetch', '--quiet', '--tags', '--force', remote], { cwd: repoRoot, timeoutMs: checkTimeoutMs })
      } else if (step.id === 'checkout') {
        const blocked = trackedChanges((await git(['status', '--porcelain'], 120000)).tail.trim())
        if (blocked) {
          result = { code: 1, tail: '工作区有未提交改动，已暂停更新：\n' + tailOf(blocked, 2000), ms: 0, spawnError: undefined }
        } else if (!releaseTag) {
          result = { code: 1, tail: '没有目标发布 tag：请先点「检查更新」', ms: 0, spawnError: undefined }
        } else {
          state.previousSha = gitSync(repoRoot, ['rev-parse', 'HEAD'])
          result = await runCommand('git', ['-c', 'advice.detachedHead=false', 'checkout', '--detach', releaseTag], { cwd: repoRoot, timeoutMs: checkTimeoutMs })
        }
      } else if (step.id === 'reset') {
        state.previousSha = gitSync(repoRoot, ['rev-parse', 'HEAD'])
        result = await runCommand('git', ['reset', '--hard', resetSha], { cwd: repoRoot, timeoutMs: checkTimeoutMs })
      } else if (step.id === 'install') {
        result = await runCommand(pnpmCommand, ['install', '--frozen-lockfile'], { cwd: repoRoot, timeoutMs: stepTimeoutMs })
      } else if (step.id === 'clean') {
        result = await runCommand(pnpmCommand, ['clean'], { cwd: repoRoot, timeoutMs: stepTimeoutMs })
      } else {
        result = await runCommand(pnpmCommand, ['build:official'], { cwd: repoRoot, timeoutMs: stepTimeoutMs })
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
  parseVersion,
  compareVersions,
  isReleaseVersion,
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