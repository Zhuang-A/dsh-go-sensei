// test/cache.test.mjs — cache.js 单测（同局面指纹 / LRU / 统计）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGame } from '../src/sgf.js'
import { gameFingerprint, ReviewCache } from '../src/cache.js'

const GAME_A = parseGame('(;GM[1]FF[4]SZ[19]KM[7.5]RU[Chinese];B[pd];W[dp];B[qp])')
const GAME_A2 = parseGame('(;GM[1]FF[4]SZ[19]KM[7.5]RU[Chinese];B[pd];W[dp];B[qp])')
const GAME_B = parseGame('(;GM[1]FF[4]SZ[19]KM[7.5]RU[Chinese];B[pd];W[dp];B[dp])')

test('gameFingerprint: 同一棋谱指纹一致', () => {
  assert.equal(gameFingerprint(GAME_A), gameFingerprint(GAME_A2))
})

test('gameFingerprint: 不同棋谱指纹不同', () => {
  assert.notEqual(gameFingerprint(GAME_A), gameFingerprint(GAME_B))
})

test('gameFingerprint: 参数差异影响指纹', () => {
  const withKomi = parseGame('(;GM[1]FF[4]SZ[19]KM[6.5]RU[Chinese];B[pd];W[dp];B[qp])')
  assert.notEqual(gameFingerprint(GAME_A), gameFingerprint(withKomi))
})

test('ReviewCache: 命中与未命中', () => {
  const cache = new ReviewCache()
  const key = cache.keyFor(GAME_A, { level: '18K' })
  assert.equal(cache.get(key), undefined)
  cache.set(key, { candidates: [{ moveNumber: 3 }] })
  const hit = cache.get(key)
  assert.deepEqual(hit, { candidates: [{ moveNumber: 3 }] })
  const stats = cache.stats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
  assert.equal(stats.entries, 1)
})

test('ReviewCache: 不同复盘参数键不同', () => {
  const cache = new ReviewCache()
  const k1 = cache.keyFor(GAME_A, { level: '18K', scope: 'review' })
  const k2 = cache.keyFor(GAME_A, { level: '3D', scope: 'review' })
  const k3 = cache.keyFor(GAME_A, { level: '18K', scope: 'context', winrateThreshold: 0.05 })
  assert.notEqual(k1, k2)
  assert.notEqual(k1, k3)
})

test('ReviewCache: LRU 淘汰最旧条目', () => {
  const cache = new ReviewCache({ maxEntries: 2 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a') // 触达 a，b 变最旧
  cache.set('c', 3) // 淘汰 b
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.stats().entries, 2)
})
