// test/manifest.test.mjs — 插件清单（package.json 的 dsh 段）契约测试
//
// 为什么要有这一层：清单字段是**宿主侧的闸门与展示**读的，写错了本地跑测试完全不报，
// 只有在真机上装/升级时才暴露 ——
//   · `engines.dsh` 只认 `>=X.Y.Z[-预发布]` 形式（其他形式插件管理器判"无法判定"并 fail-closed）；
//   · `dsh.bundle.patch` 指错文件 → 整包在组合树里挂不上；
//   · `dsh.client` 声明错平台/inject → 浏览器 half 静默不注册；
//   · `dsh.compatibility.dshReleases` 是对外声明的"这版能跑在哪些核上"，
//     实测过的版本必须标 compatible（历史遗留的 unknown 会让人以为没验过）。
// 参考：DSH 0.2.0 的 @deepseek-ai/dsh-package-manifest（字段含义）与
// @deepseek-ai/dsh-app-boot 的 evaluatePluginCompatibility（只强制 peerDependencies）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('清单: engines.dsh 必须是 >=X.Y.Z[-预发布] 形式（其他形式会被判"无法判定"）', () => {
  const range = pkg.dsh?.engines?.dsh
  assert.equal(typeof range, 'string')
  assert.match(range, /^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    `engines.dsh 形式不被插件管理器识别：${range}`)
  // 0.2.0 线必须落在范围内（当前桌面端与 web profile 的目标版本）
  const floor = /^>=(\d+)\.(\d+)\.(\d+)/.exec(range)
  assert.ok(Number(floor[1]) === 0 && Number(floor[2]) <= 2, `范围下界不该高于 0.2.0：${range}`)
})

test('清单: manifestVersion 与 bundle.patch 都指向真实存在的东西', () => {
  assert.equal(pkg.dsh?.manifestVersion, 1, 'dsh.manifestVersion 声明为 1（0.2.0 起的清单格式标识）')
  const patch = pkg.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string')
  assert.ok(existsSync(join(root, patch)), `bundle.patch 指向的文件不存在：${patch}`)
  // patch 里必须真的插入本插件（否则装了也不进组合树）
  const text = readFileSync(join(root, patch), 'utf8')
  assert.ok(/insert:/.test(text) && text.includes(pkg.name), 'patch 要用 insert: 挂上本插件')
})

test('清单: 浏览器 half 的声明与源码一致', () => {
  const client = pkg.dsh?.client
  assert.ok(client, '要声明 dsh.client，否则客户端一半不会被装载')
  assert.equal(client.platform, 'web')
  assert.ok(Array.isArray(client.inject) && client.inject.length > 0, '要声明客户端注入的宿主模块')
  for (const name of client.inject) assert.match(name, /^@deepseek-ai\/dsh-client-/)
  // 客户端 bundle 的装载协议：id 必须等于包名（宿主按 id 去重）
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  const id = /id:\s*'([^']+)'/.exec(source)
  assert.ok(id, 'client.js 要调用 ModuleLoader.load({ id })')
  assert.equal(id[1], pkg.name)
})

test('清单: exports/files 覆盖运行时要用的每一个产物', () => {
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    assert.ok(existsSync(join(root, target)), `exports["${key}"] 指向的文件不存在：${target}`)
  }
  assert.equal(pkg.main, './index.mjs'.replace('./', ''))
  assert.ok(existsSync(join(root, pkg.main)))
  // files 是发布白名单：宿主 half / 客户端 half / 源码 / patch 缺一不可
  for (const need of ['index.mjs', 'client.js', 'src/', 'cordis.patch.yml']) {
    assert.ok(pkg.files.includes(need), `files 里缺少 ${need}（发布后会缺文件）`)
  }
})

test('清单: 兼容表里实测过的 DSH 版本都标了 compatible', () => {
  const table = pkg.dsh?.compatibility?.dshReleases
  assert.ok(table && typeof table === 'object', '要保留 dshReleases 兼容表（对外声明用）')
  const allowed = new Set(['compatible', 'unknown', 'incompatible'])
  for (const [version, status] of Object.entries(table)) {
    assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `版本号写法不合法：${version}`)
    assert.ok(allowed.has(status), `${version} 的状态不在 {compatible,unknown,incompatible}：${status}`)
  }
  // 实测基线（2026-09-30，桌面端内核 0.2.0-rc.2）：tools 七件套注册成功、四处客户端插槽
  // 全部 active、面板路由闸门生效、补算 30 手并写回副本、294 条测试通过 —— 记为 compatible。
  assert.equal(table['0.2.0-rc.2'], 'compatible', '实测过的 0.2.0-rc.2 必须标 compatible')
  // engines.dsh 的下界必须在表里（不然没人知道这版从哪来）
  const floor = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(pkg.dsh.engines.dsh)?.[1]
  assert.ok(table[floor] !== undefined, `engines.dsh 下界 ${floor} 应出现在兼容表里`)
})

test('清单: 该忽略的派生产物不会进仓库', () => {
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
  assert.ok(ignore.includes('*-sensei.sgf'), '复盘副本（含真实野狐 ID）必须被忽略')
  assert.ok(ignore.includes('.go-sensei/'), '配图目录必须被忽略')
})
