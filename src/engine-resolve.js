// src/engine-resolve.js — 「用哪个 KataGo」只在这里决定
//
// 目标：让用户装完就能用，同时留出换引擎/换模型的明确口子。解析优先级：
//   ① 显式配置永远优先：kataGoPath / kataGoConfig / kataGoModel；
//   ② 目录：cfg.engineDir → cfg.kataGoPath 所在目录 → 插件自带的 engine/；
//   ③ 权重没显式指定时：在引擎目录里挑**最大**的 *.bin.gz（网络越大越强），
//      再退回配置文件里的 modelFile。
//
// 所有文件系统访问都经 deps 注入，便于单测构造"有/没有引擎"的环境，
// 也让本模块不依赖真实磁盘布局。返回值里不出现 undefined（工具返回值必须
// 是 lossless JSON，undefined 会被整体拒收）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（本文件位于 <pkg>/src/ 下）。 */
export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 随包分发的引擎目录名（相对包根）。 */
export const ENGINE_DIR_NAME = 'engine'

/** 随包分发的 analysis 配置文件名。 */
export const CONFIG_FILE_NAME = 'analysis_example.cfg'

/** 引擎可执行文件候选名（Windows 发行版用 .exe）。 */
const EXE_NAMES = ['katago.exe', 'katago']

/** 权重文件后缀。 */
const MODEL_SUFFIX = '.bin.gz'

/** 去空白后取字符串；非字符串一律当空串。 */
function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 把路径解析为绝对路径（相对路径按 base 解析）。 */
function toAbsolute(value, base) {
  return isAbsolute(value) ? value : resolve(base, value)
}

/** 默认的文件系统适配器。 */
function defaultIo() {
  return {
    exists: (path) => existsSync(path),
    listDir: (dir) => readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const full = join(dir, entry.name)
      let size = 0
      try {
        size = entry.isDirectory() ? 0 : statSync(full).size
      } catch {
        size = 0
      }
      return { name: entry.name, dir: entry.isDirectory(), size }
    }),
    readText: (path) => readFileSync(path, 'utf8'),
    sizeOf: (path) => statSync(path).size,
    platform: process.platform,
    packageDir: PACKAGE_DIR,
  }
}

/** 合并注入的依赖与默认实现。 */
function makeIo(deps) {
  const base = defaultIo()
  const merged = { ...base }
  for (const key of ['exists', 'listDir', 'readText', 'sizeOf', 'platform', 'packageDir']) {
    if (deps[key] !== undefined) merged[key] = deps[key]
  }
  return merged
}

/** 列目录；目录不存在或无权限时返回空数组（解析绝不因 IO 失败而抛错）。 */
function safeList(io, dir) {
  try {
    const entries = io.listDir(dir)
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

/**
 * 在目录里找引擎可执行文件。
 * @param {object} io 文件系统适配器
 * @param {string} dir 目录
 * @returns {string} 命中路径；未命中为空串
 */
function findExecutable(io, dir) {
  for (const name of EXE_NAMES) {
    const candidate = join(dir, name)
    if (io.exists(candidate)) return candidate
  }
  return ''
}

/**
 * 在目录里挑权重：取最大的 *.bin.gz（b28 比 b18 大，也正是更强的那个）。
 * @param {object} io 文件系统适配器
 * @param {string} dir 目录
 * @returns {{ path: string, name: string, size: number } | undefined}
 */
export function pickModel(io, dir) {
  const models = safeList(io, dir)
    .filter((entry) => entry.dir !== true && String(entry.name).toLowerCase().endsWith(MODEL_SUFFIX))
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
  if (models.length === 0) return undefined
  const best = models[0]
  return { path: join(dir, best.name), name: best.name, size: best.size ?? 0 }
}

/**
 * 从 analysis 配置文本里读 `modelFile`（跳过被注释掉的行）。
 * @param {string} text 配置文本
 * @returns {string} 配置里的 modelFile（原样，未解析相对路径）；没有则空串
 */
export function readModelFileKey(text) {
  if (typeof text !== 'string' || text === '') return ''
  for (const line of text.split('\n')) {
    const withoutComment = line.split('#')[0]
    const m = /^\s*modelFile\s*=\s*(.+?)\s*$/.exec(withoutComment)
    if (m) {
      const value = m[1].replace(/^["']|["']$/g, '').trim()
      if (value !== '') return value
    }
  }
  return ''
}

/**
 * 解析当前可用的 KataGo 引擎、配置与权重。
 *
 * @param {object} [cfg] 插件配置（读 engineDir / kataGoPath / kataGoConfig / kataGoModel）
 * @param {object} [deps] 注入的文件系统适配器（测试用）
 * @returns {object} 全部字段均为具体值（无 undefined）：
 *   { available, source, engineDir, kataGoPath, configPath, modelPath,
 *     modelName, modelSizeMB, modelSource, platform, warning, hint }
 */
export function resolveEngine(cfg = {}, deps = {}) {
  const io = makeIo(deps ?? {})
  const packageDir = io.packageDir
  const bundledDir = join(packageDir, ENGINE_DIR_NAME)

  const configuredExe = str(cfg.kataGoPath)
  const configuredConfig = str(cfg.kataGoConfig)
  const configuredModel = str(cfg.kataGoModel)
  const explicitDir = str(cfg.engineDir)

  // 目录优先级：显式 engineDir → 显式 exe 所在目录 → 自带 engine/
  const usingBundled = explicitDir === '' && configuredExe === ''
  const engineDir = explicitDir !== ''
    ? toAbsolute(explicitDir, packageDir)
    : configuredExe !== ''
      ? dirname(toAbsolute(configuredExe, packageDir))
      : bundledDir

  // 自带的可执行文件是 Windows 发行版：别的平台不自动认，避免"找得到却跑不起来"。
  const bundledExeUsable = usingBundled && io.platform === 'win32'

  let kataGoPath = configuredExe !== '' ? toAbsolute(configuredExe, packageDir) : ''
  let source = kataGoPath !== '' ? 'config' : 'none'
  if (kataGoPath === '' && (explicitDir !== '' || bundledExeUsable)) {
    const found = findExecutable(io, engineDir)
    if (found !== '') {
      kataGoPath = found
      source = usingBundled ? 'bundled' : 'engineDir'
    }
  }

  // 配置：显式优先，其次引擎目录里的 analysis_example.cfg
  let configPath = configuredConfig !== '' ? toAbsolute(configuredConfig, packageDir) : ''
  if (configPath === '') {
    const candidate = join(engineDir, CONFIG_FILE_NAME)
    if (io.exists(candidate)) configPath = candidate
  }

  // 权重：显式优先 → 引擎目录里最大的 *.bin.gz → 配置里的 modelFile
  let modelPath = ''
  let modelName = ''
  let modelSizeMB = 0
  let modelSource = 'none'
  if (configuredModel !== '') {
    modelPath = toAbsolute(configuredModel, packageDir)
    modelName = modelPath.split(/[/\\]/).pop() ?? ''
    modelSource = 'config'
    try {
      modelSizeMB = Math.round(((io.sizeOf(modelPath) ?? 0) / (1024 * 1024)) * 10) / 10
    } catch {
      modelSizeMB = 0
    }
  } else {
    const picked = pickModel(io, engineDir)
    if (picked !== undefined) {
      modelPath = picked.path
      modelName = picked.name
      modelSizeMB = Math.round((picked.size / (1024 * 1024)) * 10) / 10
      modelSource = 'engineDir'
    } else if (configPath !== '') {
      let text = ''
      try {
        text = io.readText(configPath)
      } catch {
        text = ''
      }
      const key = readModelFileKey(text)
      if (key !== '') {
        modelPath = toAbsolute(key, dirname(configPath))
        modelName = modelPath.split(/[/\\]/).pop() ?? ''
        modelSource = 'configFile'
      }
    }
  }

  const available = kataGoPath !== ''
  let warning = ''
  if (available && modelPath === '') {
    warning = `找不到权重文件：把 *.bin.gz 放进 ${engineDir}，或设置 kataGoModel 指向权重文件`
  }
  let hint = ''
  if (!available) {
    hint = io.platform === 'win32'
      ? `没有可用的 KataGo：把引擎目录填进 engineDir（或把 katago.exe 路径填进 kataGoPath），自带目录为 ${bundledDir}`
      : `随包自带的 katago.exe 是 Windows 版，当前平台（${io.platform}）需要自己下载对应平台的 KataGo，并把 engineDir 或 kataGoPath 指向它`
  }

  return {
    available,
    source,
    engineDir,
    kataGoPath,
    configPath,
    modelPath,
    modelName,
    modelSizeMB,
    modelSource,
    platform: String(io.platform ?? ''),
    warning,
    hint,
  }
}

/**
 * 人类可读的引擎描述（供工具输出与提示语引用）。
 * @param {object} resolved resolveEngine 的返回值
 * @returns {string} 如 `自带 engine（kata1-b18c384nbt-….bin.gz，93.4 MB）`
 */
export function describeEngine(resolved) {
  if (resolved === undefined || resolved.available !== true) return '未配置 KataGo'
  const where = resolved.source === 'bundled'
    ? '插件自带引擎'
    : resolved.source === 'config'
      ? '配置指定的引擎'
      : 'engineDir 指定的引擎'
  if (resolved.modelName === '') return `${where}（未找到权重）`
  const size = resolved.modelSizeMB > 0 ? `，${resolved.modelSizeMB} MB` : ''
  return `${where} + 权重 ${resolved.modelName}${size}`
}
