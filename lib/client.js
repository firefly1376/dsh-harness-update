window.__ModuleLoader__.load({
  id: "dsh-harness-update",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")

    var API = "/harness-update/api"
    var REQUEST_TIMEOUT_MS = 15000
    var POLL_MS = 3000

    function log(message) {
      try { console.log("[dsh-harness-update] " + message) } catch (err) { /* console closed */ }
    }

    async function callApi(action) {
      var init = action === "status" ? { cache: "no-store" } : { method: "POST", cache: "no-store" }
      var timer = null
      if (typeof AbortController === "function") {
        var controller = new AbortController()
        init.signal = controller.signal
        timer = setTimeout(function () { controller.abort() }, REQUEST_TIMEOUT_MS)
      }
      try {
        var res = await fetch(API + "/" + action, init)
        if (!res.ok) throw new Error("HTTP " + res.status)
        return await res.json()
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    var C = {
      row: { display: "flex", flexDirection: "column", gap: "8px", padding: "10px 0" },
      line: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
      title: { fontSize: "14px", lineHeight: "22px", color: "var(--dsw-alias-label-primary)" },
      muted: { fontSize: "12px", lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" },
      active: { fontSize: "12px", lineHeight: "20px", color: "var(--dsw-alias-brand-primary)" },
      small: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", fontFamily: "ui-monospace, Menlo, monospace" },
      actions: { display: "flex", gap: "6px", alignItems: "center", flexShrink: 0 },
      btn: { fontSize: "12px", padding: "3px 10px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-primary)", cursor: "pointer" },
      primary: { fontSize: "12px", padding: "3px 10px", borderRadius: "6px", border: "1px solid var(--dsw-alias-brand-primary)", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)", cursor: "pointer" },
      pre: { margin: "4px 0 0", padding: "6px 8px", maxHeight: "160px", overflow: "auto", borderRadius: "6px", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", fontSize: "11px", whiteSpace: "pre-wrap" },
    }

    function stepMark(state) {
      if (state === "ok") return "✓"
      if (state === "failed") return "✕"
      if (state === "running") return "●"
      return "○"
    }

    function clock(value) {
      if (!value) return ""
      try { return new Date(value).toLocaleTimeString() } catch (err) { return String(value) }
    }

    function statusText(st, busyAction) {
      if (busyAction === "check") return "检查中…（git fetch + 比较远端）"
      if (busyAction === "install") return st && st.available ? "更新中…" : "开始强制重建…"
      if (busyAction === "rollback") return "回滚中…"
      if (!st) return "读取状态中…"
      if (st.phase === "running") {
        var running = (st.steps || []).filter(function (s) { return s.state === "running" })[0]
        return running ? running.label + "…" : "更新中…"
      }
      if (st.available) return "新版本 " + (st.available.version || "?") + "，落后 " + st.available.behind + " 个提交 · 点「更新」"
      if (st.restartRequired) return "已更新，重启 DSH 后生效"
      if (st.lastCheckedAt) return "已是最新 · 检查于 " + clock(st.lastCheckedAt)
      return "尚未检查"
    }

    function Row() {
      var state = React.useState(undefined)
      var st = state[0]
      var setSt = state[1]
      var busyState = React.useState(null)
      var busyAction = busyState[0]
      var setBusyAction = busyState[1]
      var errState = React.useState(undefined)
      var err = errState[0]
      var setErr = errState[1]
      var e = React.createElement

      var load = function () {
        callApi("status")
          .then(function (next) { if (next) { setSt(next); setErr(undefined) } })
          .catch(function (error) { setErr(String(error && error.message ? error.message : error)) })
      }

      React.useEffect(function () {
        load()
        var timer = setInterval(load, POLL_MS)
        return function () { clearInterval(timer) }
      }, [])

      var run = function (action) {
        if (busyAction !== null) return
        setBusyAction(action)
        setErr(undefined)
        callApi(action)
          .then(function (next) { if (next) setSt(next) })
          .catch(function (error) { setErr(String(error && error.message ? error.message : error)) })
          .then(function () { setBusyAction(null) })
      }

      var isRunning = !!st && st.phase === "running"
      var locked = busyAction !== null || isRunning
      var runtime = (st && st.runtime) || {}
      var steps = (st && st.steps) || []
      var failed = steps.filter(function (s) { return s.state === "failed" })[0]
      var statusLabel = busyAction !== null || isRunning ? C.active : C.muted
      var children = [
        e("div", { key: "line", style: C.line }, [
          e("div", { key: "left", style: { minWidth: 0 } }, [
            e("div", { key: "title", style: C.title }, "DSH 版本"),
            e("div", { key: "status", style: statusLabel }, err ? "状态读取失败：" + err : statusText(st, busyAction)),
          ]),
          e("div", { key: "actions", style: C.actions }, [
            e("button", { key: "check", type: "button", style: C.btn, disabled: locked, onClick: function () { run("check") } }, busyAction === "check" ? "检查中…" : "检查更新"),
            e("button", { key: "install", type: "button", style: C.primary, disabled: locked, onClick: function () { run("install") } }, busyAction === "install" ? "更新中…" : "更新"),
            st && st.previousSha ? e("button", { key: "rollback", type: "button", style: C.btn, disabled: locked, onClick: function () { run("rollback") } }, busyAction === "rollback" ? "回滚中…" : "回滚") : null,
          ]),
        ]),
      ]
      if (runtime.version) children.push(e("div", { key: "meta", style: C.small }, "当前 " + runtime.version + " · " + (runtime.shortSha || "") + (st && st.previousSha ? " · 可回滚到 " + String(st.previousSha).slice(0, 8) : "") + (runtime.stale ? " · 磁盘代码已变，需重启" : "")))
      if (st && st.lastError) children.push(e("div", { key: "err", style: C.small }, st.lastError))
      if (steps.length > 0 && st.phase !== "idle") children.push(e("div", { key: "steps", style: C.small }, steps.map(function (s) { return stepMark(s.state) + " " + s.label + (s.ms === undefined || s.ms === null ? "" : " (" + (s.ms / 1000).toFixed(1) + "s)") }).join("   ")))
      if (failed && failed.tail) children.push(e("pre", { key: "tail", style: C.pre }, failed.tail))
      return e("div", { style: C.row }, children)
    }

    function apply(ctx) {
      log("client half loaded")
      ctx.slots.inject("settings.general.item", function () {
        return ctx.slots.register({ name: "settings.general.item", id: "harness-update", order: 60 }, Row)
      })
    }

    exports.apply = apply
    exports.inject = ["slots"]
    return module.exports
  },
})