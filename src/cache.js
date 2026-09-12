// src/cache.js — 同局面哈希缓存
//
// 同一棋谱 + 同一复盘参数 = 同一缓存键；命中时工具返回"来自缓存"的裁剪结果，
// 省去模型重复获取全量局面上下文的 token 消耗（懒生成 + 缓存，配合 token 预算）。

import { createHash } from 'node:crypto'

/**
 * @param {object} game parseGame 的返回值
 * @returns {string} 与讲解无关的棋局指纹（主变化线 + 摆子 + 规则参数）
 */
export function gameFingerprint(game) {
  const info = game?.info ?? {}
  const seq = (game?.moves ?? []).map((m) => `${m.color}${m.coord ?? 'tt'}`).join('')
  // 摆子必须进指纹：同一贴目/规则下的两道死活题（只有 AB/AW、没有着手）
  // 若不算进去就会撞成同一个键，第二题会拿到第一题的缓存结果。
  const setup = game?.setup ?? {}
  const stones = [
    ...(setup.black ?? []).map((c) => `B${c}`),
    ...(setup.white ?? []).map((c) => `W${c}`),
  ].sort().join('')
  const raw = [info.size, info.komi, info.handicap, info.rule ?? '', info.result ?? '', seq, stones].join('|')
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/**
 * LRU 缓存。key 由调用方用 {@link gameFingerprint} + 复盘参数拼出。
 */
export class ReviewCache {
  constructor({ maxEntries = 512 } = {}) {
    this.maxEntries = maxEntries
    this.map = new Map() // key -> { value, savedAt }
    this.hits = 0
    this.misses = 0
  }

  keyFor(game, { level = 'auto', winrateThreshold, scoreThreshold, scope = 'review' } = {}) {
    const raw = [
      gameFingerprint(game),
      level,
      winrateThreshold ?? '',
      scoreThreshold ?? '',
      scope,
    ].join('|')
    return createHash('sha256').update(raw).digest('hex').slice(0, 24)
  }

  get(key) {
    const entry = this.map.get(key)
    if (entry === undefined) {
      this.misses += 1
      return undefined
    }
    // LRU 触达：移到队尾
    this.map.delete(key)
    this.map.set(key, entry)
    this.hits += 1
    return entry.value
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, savedAt: Date.now() })
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }

  stats() {
    return { hits: this.hits, misses: this.misses, entries: this.map.size, maxEntries: this.maxEntries }
  }
}
