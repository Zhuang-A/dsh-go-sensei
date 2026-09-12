// test/engine-resolve.test.mjs — 「用哪个 KataGo / 哪个权重」的解析规则
//
// 覆盖三件事：
//   1. 开箱即用：不带任何配置时认插件自带的 engine/ 目录（Windows），
//      并在其中自动挑最大的 *.bin.gz；
//   2. 口子：engineDir / kataGoPath / kataGoConfig / kataGoModel 的优先级，
//      以及配置里 modelFile 的兜底；
//   3. 健壮性：目录不存在不抛错、返回值不含 undefined（工具返回值必须是
//      lossless JSON，undefined 会被运行时整体拒收）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  resolveEngine,
  pickModel,
  readModelFileKey,
  describeEngine,
  PACKAGE_DIR,
  ENGINE_DIR_NAME,
  CONFIG_FILE_NAME,
} from '../src/engine-resolve.js'

const PKG = '/pkg'
const ENGINE_DIR = join(PKG, ENGINE_DIR_NAME)
const BUNDLED_EXE = join(ENGINE_DIR, 'katago.exe')
const BUNDLED_CFG = join(ENGINE_DIR, CONFIG_FILE_NAME)

/**
 * 假文件系统：把「存在哪些路径」「目录里有什么」「文件里写了什么」完全交给测试，
 * 于是解析规则可以在没有真实引擎的机器上被断言。
 */
function fakeIo({ files = [], dirs = {}, texts = {}, sizes = {}, platform = 'win32' } = {}) {
  const present = new Set(files)
  return {
    exists: (p) => present.has(p),
    listDir: (dir) => dirs[dir] ?? [],
    readText: (p) => {
      if (!(p in texts)) throw new Error(`no such file: ${p}`)
      return texts[p]
    },
    sizeOf: (p) => sizes[p] ?? 0,
    platform,
    packageDir: PKG,
  }
}

/** 列出对象里所有值为 undefined 的属性路径。 */
function undefinedPaths(value, path = '$', out = []) {
  if (value === undefined) { out.push(path); return out }
  if (value === null || typeof value !== 'object') return out
  for (const key of Object.keys(value)) undefinedPaths(value[key], `${path}.${key}`, out)
  return out
}

test('自带引擎：认 engine 目录里的可执行文件、配置与最大的权重', () => {
  const io = fakeIo({
    files: [BUNDLED_EXE, BUNDLED_CFG],
    dirs: {
      [ENGINE_DIR]: [
        { name: 'kata1-b18c384nbt-s1.bin.gz', dir: false, size: 98_000_000 },
        { name: 'kata1-b28c512nbt-s2.bin.gz', dir: false, size: 271_000_000 },
        { name: 'KataGoData', dir: true, size: 0 },
        { name: 'README.md', dir: false, size: 3000 },
      ],
    },
  })
  const r = resolveEngine({}, io)
  assert.equal(r.available, true)
  assert.equal(r.source, 'bundled')
  assert.equal(r.engineDir, ENGINE_DIR)
  assert.equal(r.kataGoPath, BUNDLED_EXE)
  assert.equal(r.configPath, BUNDLED_CFG)
  assert.equal(r.modelName, 'kata1-b28c512nbt-s2.bin.gz') // 取最大，不是第一个
  assert.equal(r.modelSource, 'engineDir')
  assert.ok(r.modelSizeMB > 200)
  assert.equal(r.warning, '')
})

test('非 Windows：不自动启用自带的 katago.exe，并说明原因', () => {
  const io = fakeIo({ files: [BUNDLED_EXE, BUNDLED_CFG], platform: 'linux' })
  const r = resolveEngine({}, io)
  assert.equal(r.available, false)
  assert.equal(r.source, 'none')
  assert.equal(r.kataGoPath, '')
  assert.ok(r.hint.includes('Windows'))
})

test('显式 engineDir：可用自定义引擎目录（含无扩展名的 katago）', () => {
  const dir = join('/my', 'engine')
  const io = fakeIo({
    files: [join(dir, 'katago'), join(dir, CONFIG_FILE_NAME)],
    dirs: { [dir]: [{ name: 'my-net.bin.gz', dir: false, size: 4096 }] },
  })
  const r = resolveEngine({ engineDir: dir }, io)
  assert.equal(r.available, true)
  assert.equal(r.source, 'engineDir')
  assert.equal(r.kataGoPath, join(dir, 'katago'))
  assert.equal(r.configPath, join(dir, CONFIG_FILE_NAME))
  assert.equal(r.modelPath, join(dir, 'my-net.bin.gz'))
})

test('显式配置优先：kataGoPath / kataGoConfig / kataGoModel 覆盖一切', () => {
  const dir = join('/custom', 'kg')
  const exe = join(dir, 'katago.exe')
  const cfgPath = join(dir, 'my.cfg')
  const model = join(dir, 'w.bin.gz')
  const io = fakeIo({
    files: [BUNDLED_EXE, BUNDLED_CFG, exe, cfgPath, model],
    sizes: { [model]: 2 * 1024 * 1024 },
  })
  const r = resolveEngine({ kataGoPath: exe, kataGoConfig: cfgPath, kataGoModel: model }, io)
  assert.equal(r.source, 'config')
  assert.equal(r.engineDir, dir) // exe 所在目录即引擎目录
  assert.equal(r.kataGoPath, exe)
  assert.equal(r.configPath, cfgPath)
  assert.equal(r.modelPath, model)
  assert.equal(r.modelSource, 'config')
  assert.equal(r.modelSizeMB, 2)
})

test('权重兜底：目录里没有 *.bin.gz 时读配置里的 modelFile（跳过注释行）', () => {
  const dir = join('/bare', 'engine')
  const cfgPath = join(dir, CONFIG_FILE_NAME)
  const io = fakeIo({
    files: [join(dir, 'katago.exe'), cfgPath],
    dirs: { [dir]: [] },
    texts: {
      [cfgPath]: '# modelFile = commented-out.bin.gz\nreportAnalysisWinratesAs = BLACK\nmodelFile = ../weights/b28.bin.gz\n',
    },
  })
  const r = resolveEngine({ engineDir: dir }, io)
  assert.equal(r.available, true)
  assert.equal(r.modelSource, 'configFile')
  assert.equal(r.modelPath, resolve(dir, '..', 'weights', 'b28.bin.gz'))
  assert.equal(r.modelName, 'b28.bin.gz')
})

test('引擎可用但没有权重 → warning 直接指路', () => {
  const dir = join('/noweight', 'engine')
  const cfgPath = join(dir, CONFIG_FILE_NAME)
  const io = fakeIo({
    files: [join(dir, 'katago.exe'), cfgPath],
    dirs: { [dir]: [] },
    texts: { [cfgPath]: 'reportAnalysisWinratesAs = BLACK\n' },
  })
  const r = resolveEngine({ engineDir: dir }, io)
  assert.equal(r.available, true)
  assert.equal(r.modelPath, '')
  assert.ok(r.warning.includes('kataGoModel'))
})

test('引擎目录不存在：不抛错，只报告不可用', () => {
  const r = resolveEngine({ engineDir: '/definitely/missing' }, fakeIo({}))
  assert.equal(r.available, false)
  assert.equal(r.kataGoPath, '')
  assert.equal(r.configPath, '')
  assert.equal(r.modelPath, '')
  assert.equal(r.modelName, '')
  assert.ok(r.hint.length > 0)
  assert.equal(describeEngine(r), '未配置 KataGo')
})

test('解析结果不含 undefined（工具返回值必须是 lossless JSON）', () => {
  const r = resolveEngine({}, fakeIo({ files: [BUNDLED_EXE, BUNDLED_CFG] }))
  assert.deepEqual(undefinedPaths(r), [])
  assert.equal(typeof describeEngine(r), 'string')
})

test('pickModel：只认 *.bin.gz 文件，忽略目录与其他文件', () => {
  const dir = '/x'
  const io = fakeIo({
    dirs: {
      [dir]: [
        { name: 'a-dir', dir: true, size: 999 },
        { name: 'note.txt', dir: false, size: 5 },
        { name: 'm1.bin.gz', dir: false, size: 1 },
        { name: 'm2.BIN.GZ', dir: false, size: 2 },
      ],
    },
  })
  assert.equal(pickModel(io, dir).name, 'm2.BIN.GZ')
  assert.equal(pickModel(io, '/empty'), undefined)
})

test('readModelFileKey：跳过注释，取第一条生效的 modelFile', () => {
  assert.equal(readModelFileKey('# modelFile = a.bin.gz\nmodelFile = b.bin.gz # 说明\n'), 'b.bin.gz')
  assert.equal(readModelFileKey('reportAnalysisWinratesAs = BLACK\n'), '')
  assert.equal(readModelFileKey(''), '')
})

// ---------------------------------------------------------------------------
// 真实磁盘：确认随包分发的引擎确实在包里（这条在任何平台都该通过）
// ---------------------------------------------------------------------------

test('随包分发的 engine/ 内容完整', () => {
  const engineDir = join(PACKAGE_DIR, ENGINE_DIR_NAME)
  assert.ok(existsSync(join(engineDir, 'katago.exe')), '应随包分发 katago.exe')
  assert.ok(existsSync(join(engineDir, CONFIG_FILE_NAME)), '应随包分发 analysis_example.cfg')
  assert.ok(existsSync(join(engineDir, 'LICENSE.txt')), '应随包分发引擎许可')
  const models = readdirSync(engineDir).filter((name) => name.toLowerCase().endsWith('.bin.gz'))
  assert.ok(models.length >= 1, '至少应随包分发一个权重文件')
  assert.ok(existsSync(join(engineDir, 'analysis_logs')), '日志目录必须存在（引擎要往里写）')
})

test('真实磁盘 + Windows：零配置即可解析到自带引擎', { skip: process.platform !== 'win32' }, () => {
  const r = resolveEngine({})
  assert.equal(r.available, true)
  assert.equal(r.source, 'bundled')
  assert.ok(r.kataGoPath.endsWith('katago.exe'))
  assert.ok(r.modelName.endsWith('.bin.gz'))
  assert.ok(r.modelSizeMB > 50, '自带权重应有几十 MB 量级')
})
