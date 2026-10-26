/**
 * 计划器：把"作息窗口"换算成今天醒来的绝对时刻。
 *
 * 设计取向和 bili-whale 一致：用日期当随机种子 —— DSH 重启不会重新抽签，
 * 否则用户每次重启都会换一个醒来时间，看起来像"它很随意"。
 *
 * 窗口语义（v0.1）：
 *   - start/end 为当天的 HH:MM，end 允许写 24:00
 *   - 跨午夜的窗口（如 23:00–01:00）暂不支持，会被静默忽略
 *   - 每个窗口最多安排一次醒来；所有窗口都错过 → 今天不醒
 */
import crypto from 'node:crypto'

export function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!m) return null
  const value = Number(m[1]) * 60 + Number(m[2])
  return value >= 0 && value <= 1440 ? value : null
}

export function normalizeWindows(raw) {
  const out = []
  for (const w of Array.isArray(raw) ? raw : []) {
    const start = parseMinutes(w?.start)
    const end = parseMinutes(w?.end)
    if (start === null || end === null || end <= start) continue
    out.push({ start, end })
  }
  return out
}

/** 0..1 的确定性伪随机：同一个 (date, salt) 永远得到同一个值。 */
function unit(seed, salt) {
  const h = crypto.createHash('sha256').update(seed + '|' + salt).digest()
  return h.readUInt32BE(0) / 0xffffffff
}

/**
 * 生成当天计划。
 * 返回 { date, atMs, at, skip, fired, windowKey }；atMs 为 null 表示今天已无可用窗口。
 */
export function makePlan(now, night) {
  const key = dateKey(now)
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const windows = normalizeWindows(night?.windows)
  const skipChance = Math.min(1, Math.max(0, Number(night?.skipChance) || 0))

  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i]
    const startMs = dayStart + w.start * 60_000
    const endMs = dayStart + w.end * 60_000
    if (now.getTime() >= endMs) continue
    // 至少留 60 秒，避免"刚排完就立刻醒"
    const earliest = Math.max(now.getTime() + 60_000, startMs)
    if (earliest >= endMs) continue
    const slotMs = earliest + Math.floor(unit(key, 'slot' + i) * (endMs - earliest))
    return {
      date: key,
      windowKey: `${key}|${w.start}-${w.end}#${i}`,
      atMs: slotMs,
      at: new Date(slotMs).toISOString(),
      skip: unit(key, 'skip' + i) < skipChance,
      fired: false,
      firedAt: null,
      createdAt: now.toISOString(),
    }
  }
  return { date: key, windowKey: `${key}|none`, atMs: null, at: null, skip: false, fired: false, firedAt: null, createdAt: now.toISOString() }
}
