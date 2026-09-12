// test/schema.test.mjs — 工具注册契约（用**运行时真实校验器**验证 schema）
//
// 为什么单独一个文件：2026-09 出现过一次启动级故障 —— go_review_moves 的输出
// schema 写了 `autoEngine: { type: ['object','null'] }`，而 dsh-tools 的
// assertSupportedJsonSchema 只接受**单一类型字符串**，于是 ctx.tools.register
// 抛错 → 插件加载中止 → `dsh web` 起不来。
//
// 当时的 127 个单测全绿却没能拦住它：那些用例都直接调 definition.execute()，
// 从不经过注册期的真实校验。这里补上这个缺口 —— 直接 import dsh-tools 的
// assertSupportedJsonSchema，对每个工具的 parameters 与 output.schema 逐条断言。
//
// dsh 安装位置取不到时跳过（不在 dsh 环境里跑单测的场合）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply, Config } from '../index.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 运行时校验器所在包（dsh 安装目录内的 dsh-tools）。 */
const CANDIDATES = [
  'C:/Users/Zhuang/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  join(here, '..', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
]

let assertSupportedJsonSchema = null
let loadError = null
for (const candidate of CANDIDATES) {
  if (!existsSync(candidate)) continue
  try {
    const mod = await import(pathToFileURL(candidate).href)
    if (typeof mod.assertSupportedJsonSchema === 'function') {
      assertSupportedJsonSchema = mod.assertSupportedJsonSchema
      break
    }
  } catch (error) {
    loadError = error
  }
}

const skip = assertSupportedJsonSchema === null
  ? `运行时校验器不可用（${loadError ? loadError.message : '未找到 dsh-tools'}）`
  : false

/** 注册全部工具并返回 { name -> definition }。 */
function registerAllTools() {
  const registered = new Map()
  const sections = []
  const ctx = {
    tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name) } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} }, getSectionOrder: () => 0 },
    fs: {},
    get: () => undefined,
    on: () => () => {},
    emit() {},
    logger: { warn() {} },
  }
  // 配了引擎路径以把 go_engine_analyze 也纳入校验（它的 schema 同样要过校验）
  apply(ctx, Config({ kataGoPath: 'C:/fake/katago.exe' }))
  return registered
}

test('注册契约: 每个工具的 output.schema 都通过运行时 assertSupportedJsonSchema', { skip }, () => {
  const registered = registerAllTools()
  assert.ok(registered.size >= 6, `应注册 6 个工具，实际 ${registered.size}`)
  for (const [name, def] of registered) {
    assert.ok(def.output && def.output.schema, `${name} 缺少 output.schema`)
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(def.output.schema),
      `${name} 的 output.schema 不被运行时接受（插件会加载失败）`,
    )
  }
})

test('注册契约: 每个工具的 parameters 也通过运行时校验', { skip }, () => {
  const registered = registerAllTools()
  for (const [name, def] of registered) {
    assert.ok(def.parameters, `${name} 缺少 parameters`)
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(def.parameters),
      `${name} 的 parameters 不被运行时接受`,
    )
  }
})

test('注册契约: schema 中不得出现 type 数组（本次启动故障的直接原因）', { skip }, () => {
  const registered = registerAllTools()
  const offenders = []
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node.type)) offenders.push(`${path}.type = ${JSON.stringify(node.type)}`)
    for (const key of Object.keys(node)) walk(node[key], `${path}.${key}`)
  }
  for (const [name, def] of registered) {
    walk(def.parameters, `${name}.parameters`)
    walk(def.output.schema, `${name}.output.schema`)
  }
  assert.deepEqual(offenders, [], `type 必须是单一类型字符串，违规处：${offenders.join('; ')}`)
})

test('注册契约: output.schema 的 required 键都在 properties 中声明', { skip }, () => {
  const registered = registerAllTools()
  for (const [name, def] of registered) {
    const schema = def.output.schema
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(props, key), `${name}: required 里的 ${key} 未在 properties 声明`)
    }
  }
})
