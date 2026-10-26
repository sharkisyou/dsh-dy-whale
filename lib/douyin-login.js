/**
 * 抖音登录的路由层 —— 给 DSH「设置 → 抖音」里的扫码卡片用。
 *
 * 平台事实：抖音没有 bilibili 那种"接口直接给二维码数据"的登录方式。
 * 这里复用 dsh-douyin 插件自带的登录守护（python/douyin_bridge.py login-daemon）：
 *   · 守护在它自己的无头浏览器里打开 creator.douyin.com 登录页
 *   · 每 4 秒把整页截图写到 <data>/login-qrcode.png，并把阶段写进 <data>/state/login.json
 *   · 登录成功后自动把 storage_state 写成 dy-cli 的 cookie
 * 本模块负责：起/停守护、读状态、把截图裁成二维码（ffmpeg）、把短信码转交守护、
 * 以及把这些能力暴露成本地 HTTP 路由（同源 fetch，走 DSH 的信任栅栏）。
 *
 * 为什么裁剪用固定区域：抖音登录页的二维码元素没有稳定选择器（实测 class/src 都不含 qr），
 * 而登录页布局是固定的（1280×900 视口，二维码在 580,320 起 220×220）。
 * 裁歪了也不致命 —— 客户端还能切"看完整截图"。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'

const HOME = os.homedir()
const ACTIVE_PHASES = new Set(['qrcode', 'sms_verification', 'sms_code_input', 'challenge_required'])
const QR_CROP = '220:220:580:320'
const CROP_NAME = 'login-qrcode-crop.png'

const asJson = (res, code, value) => {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  } catch {}
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const exists = (file) => { try { return fs.statSync(file).isFile() } catch { return false } }

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 找 ffmpeg：显式环境变量 → PATH → bili-whale 放的那份静态构建。 */
let ffmpegCache
function findFfmpeg() {
  if (ffmpegCache !== undefined) return ffmpegCache
  const cands = [process.env.FFMPEG, path.join(HOME, '.dsh', 'bili-whale', 'bin', 'ffmpeg'), 'ffmpeg']
  for (const c of cands) {
    if (!c) continue
    try {
      if (c !== 'ffmpeg' && !exists(c)) continue
      execFileSync(c, ['-version'], { stdio: 'ignore' })
      ffmpegCache = c
      return c
    } catch {}
  }
  ffmpegCache = null
  return null
}

/** 找 Chromium：显式的 → playwright 缓存（取最新）→ 系统包。 */
function findBrowser() {
  const explicit = process.env.DOUYIN_BROWSER || process.env.DOUYIN_EDGE_PATH
  if (explicit && exists(explicit)) return explicit
  const cache = path.join(HOME, '.cache', 'ms-playwright')
  try {
    const dirs = fs.readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const d of dirs) {
      const exe = path.join(cache, d, 'chrome-linux64', 'chrome')
      if (exists(exe)) return exe
    }
  } catch {}
  for (const c of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (exists(c)) return c
  return null
}

/** 一份快照：守护阶段、截图、cookie、今天计划。 */
function snapshot(cfg) {
  const root = String(cfg.douyinRepo || '').trim()
  if (!root) return { configured: false, phase: 'idle', alive: false, cookiePresent: false }
  const data = path.join(root, 'data')
  const state = readJson(path.join(data, 'state', 'login.json')) || {}
  const shot = path.join(data, 'login-qrcode.png')
  const cookieFile = path.join(data, 'home', '.dy', 'cookies', 'default.json')
  const alive = pidAlive(state.pid)
  let phase = state.phase || 'idle'
  // 守护没了但状态还停在"等扫码" → 如实显示成已取消（照 dsh-douyin login-status 的语义）
  if (!alive && ACTIVE_PHASES.has(phase)) phase = state.phase === 'logged_in' ? phase : 'stopped'
  return {
    configured: true,
    phase,
    alive,
    pid: Number.isInteger(state.pid) ? state.pid : null,
    nickname: state.nickname || null,
    note: state.note || null,
    error: state.error || null,
    updatedAt: state.updated_at || null,
    cookiePresent: exists(cookieFile),
    screenshotAvailable: exists(shot),
    root,
  }
}

/** 把整页截图裁成二维码；裁剪失败就退回整图。按 mtime 缓存。 */
function qrDataUrl(cfg, full) {
  const root = String(cfg.douyinRepo || '').trim()
  if (!root) return null
  const data = path.join(root, 'data')
  const shot = path.join(data, 'login-qrcode.png')
  if (!exists(shot)) return null
  const mtime = fs.statSync(shot).mtimeMs
  const crop = path.join(data, CROP_NAME)
  let file = shot
  if (!full) {
    const cached = readJson(crop + '.json')
    if (!(cached && cached.src === mtime && exists(crop))) {
      const ff = findFfmpeg()
      if (ff) {
        try {
          execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-i', shot, '-vf', `crop=${QR_CROP}`, '-y', crop], { stdio: 'ignore' })
          fs.writeFileSync(crop + '.json', JSON.stringify({ src: mtime }))
        } catch {}
      }
    }
    if (exists(crop)) file = crop
  }
  try {
    return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')
  } catch {
    return null
  }
}

function bridgeEnv(cfg) {
  const root = String(cfg.douyinRepo).trim()
  const data = path.join(root, 'data')
  const browser = findBrowser()
  return {
    ...process.env,
    HOME: path.join(data, 'home'),
    USERPROFILE: path.join(data, 'home'),
    DOUYIN_DATA_DIR: data,
    DOUYIN_BROWSER: browser || '',
    DOUYIN_HEADLESS: process.env.DOUYIN_HEADLESS || '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
}

function pythonOf(cfg) {
  const root = String(cfg.douyinRepo).trim()
  const venv = path.join(root, '.venv', 'bin', 'python')
  return exists(venv) ? venv : 'python3'
}

function bridgeOf(cfg) {
  return path.join(String(cfg.douyinRepo).trim(), 'python', 'douyin_bridge.py')
}

function startDaemon(cfg, log) {
  const root = String(cfg.douyinRepo || '').trim()
  if (!root) throw new Error('还没有配置 douyinRepo（~/.dsh/dy-whale.config.json）')
  if (!exists(bridgeOf(cfg))) throw new Error('找不到 dsh-douyin 的桥脚本：' + bridgeOf(cfg))
  const child = spawn(pythonOf(cfg), [bridgeOf(cfg), 'login-daemon'], {
    cwd: root,
    env: bridgeEnv(cfg),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  log?.(`[dy-whale] 已启动抖音登录守护 pid=${child.pid}`)
}

function cancelDaemon(cfg, log) {
  const snap = snapshot(cfg)
  if (snap.pid && pidAlive(snap.pid)) {
    try { process.kill(snap.pid, 'SIGTERM') } catch {}
    log?.(`[dy-whale] 已终止登录守护 pid=${snap.pid}`)
  }
  try {
    // 守护被杀后浏览器可能还在；只清理用这个专用 profile 的进程
    execFileSync('pkill', ['-f', path.join(String(cfg.douyinRepo).trim(), 'data', 'browser-profile')], { stdio: 'ignore' })
  } catch {}
}

function submitCode(cfg, codes) {
  const root = String(cfg.douyinRepo || '').trim()
  const file = path.join(root, 'data', 'state', 'command.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ action: 'submit_code', codes, at: new Date().toISOString() }))
}

/** 轮询循环里调：已登录就停掉守护（守护自己会 close）。 */
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 64 * 1024) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

export function registerDouyinRoutes(ctx, { getConfig, log } = {}) {
  const webServer = (() => { try { return ctx.get?.('webServer') ?? ctx.webServer } catch { return null } })()
  const connection = (() => { try { return ctx.get?.('connection') ?? ctx.connection } catch { return null } })()
  if (!webServer || typeof webServer.register !== 'function') {
    log?.('[dy-whale] 没有 webServer 服务，跳过登录路由（生物钟不受影响）')
    return () => {}
  }

  const loopback = (req) => {
    const host = String(req?.headers?.host || '').toLowerCase()
    const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
  }

  /** 信任栅栏：与 bili-whale 同一套 —— 先看 Host/Origin，再交给 connection 判登录态。 */
  const gate = (req, res) => {
    if (!loopback(req)) {
      let trusted = false
      try { trusted = connection?.isTrusted?.(req) === true } catch {}
      if (!trusted) { asJson(res, 403, { ok: false, error: '不受信任的访问来源' }); return true }
    }
    try {
      if (connection && typeof connection.requestRejection === 'function') {
        const code = connection.requestRejection(req)
        if (code !== undefined && code !== null && code !== false) {
          res.statusCode = typeof code === 'number' ? code : 403
          res.end()
          return true
        }
      }
    } catch {
      asJson(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问' })
      return true
    }
    return false
  }

  const disposers = []
  const route = (pathname, handler) => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        if (gate(req, res)) return
        try { await handler(req, res) } catch (e) { asJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }))
  }

  route('/dy-whale/api/douyin', async (req, res) => {
    const cfg = getConfig()
    const snap = snapshot(cfg)
    const active = ACTIVE_PHASES.has(snap.phase) && snap.screenshotAvailable
    asJson(res, 200, {
      ok: true,
      ...snap,
      qr: active ? qrDataUrl(cfg, false) : null,
      full: active ? qrDataUrl(cfg, true) : null,
      plan: readJson(path.join(process.env.DSH_HOME || path.join(HOME, '.dsh'), 'dy-whale-plan.json')),
    })
  })

  route('/dy-whale/api/douyin/start', async (req, res) => {
    if (req.method !== 'POST') { asJson(res, 405, { ok: false }); return }
    const cfg = getConfig()
    const before = snapshot(cfg)
    if (before.alive && ACTIVE_PHASES.has(before.phase)) {
      asJson(res, 200, { ok: true, ...before, reused: true })
      return
    }
    startDaemon(cfg, log)
    asJson(res, 200, { ok: true, started: true })
  })

  route('/dy-whale/api/douyin/cancel', async (req, res) => {
    if (req.method !== 'POST') { asJson(res, 405, { ok: false }); return }
    cancelDaemon(getConfig(), log)
    asJson(res, 200, { ok: true })
  })

  route('/dy-whale/api/douyin/submit', async (req, res) => {
    if (req.method !== 'POST') { asJson(res, 405, { ok: false }); return }
    const body = await readBody(req)
    const codes = String(body.codes || '').replace(/\D/g, '').slice(0, 8)
    if (codes.length < 4) { asJson(res, 400, { ok: false, error: '请输入 4–8 位短信验证码' }); return }
    submitCode(getConfig(), codes)
    asJson(res, 200, { ok: true })
  })

  return () => { for (const d of disposers) { try { d?.() } catch {} } }
}
