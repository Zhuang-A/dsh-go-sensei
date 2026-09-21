// test/skill-install.test.mjs — 随件技能安装器（src/skill-install.js）
//
// 这是本插件唯一会**往技能根写文件**的代码，所以每条安全口径都要有用例钉住：
//   幂等 / 备份后覆盖 / keep 模式 / off 模式 / 拒链接与特殊文件 / 拒子目录 / 技能根形态校验。
// 所有用例都在 test/tmp-* 临时目录里跑，绝不碰真实的 ~/.dsh/skills。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureSkill, inspectSkill, readSkillSource, validateSkillRoot, linkResolution, SKILL_NAME, MODES,
} from '../src/skill-install.js'

const TMP = join(import.meta.dirname, 'tmp-skill-install')

/** 造一个干净的源随件目录（含 SKILL.md —— 技能根里有没有它，就是"装没装"的判据）。 */
function makeSource(root, files = { 'SKILL.md': '# skill', 'a.md': 'A', 'b.md': 'B' }) {
  const src = join(root, 'skills', SKILL_NAME)
  mkdirSync(src, { recursive: true })
  for (const [f, body] of Object.entries(files)) writeFileSync(join(src, f), body)
  return src
}

function freshRoot(tag) {
  const root = join(TMP, tag)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return root
}

test('全新环境：装成全部文件，且复探逐件一致', () => {
  const root = freshRoot('fresh')
  const src = makeSource(root)
  const skillRoot = join(root, 'home', '.dsh', 'skills')
  const res = ensureSkill({ srcDir: src, skillRoot })
  assert.equal(res.state, 'installed')
  assert.deepEqual(res.wrote.sort(), ['SKILL.md', 'a.md', 'b.md'])
  assert.equal(res.backedUp.length, 0)
  const info = inspectSkill({ srcDir: src, skillRoot })
  assert.equal(info.installed, true)
  assert.equal(info.same, true, '复探必须判定逐件一致')
  assert.deepEqual(info.differing, [])
  assert.deepEqual(info.missing, [])
})

test('幂等：再装一次不改任何东西、也不产生备份', () => {
  const root = freshRoot('idem')
  const src = makeSource(root)
  const skillRoot = join(root, 'home', '.dsh', 'skills')
  ensureSkill({ srcDir: src, skillRoot })
  const before = readdirSync(join(skillRoot, SKILL_NAME)).sort()
  const res = ensureSkill({ srcDir: src, skillRoot })
  assert.equal(res.state, 'up-to-date')
  assert.deepEqual(res.wrote, [])
  assert.deepEqual(res.backedUp, [])
  assert.deepEqual(readdirSync(join(skillRoot, SKILL_NAME)).sort(), before, '目录里不该多出 .bak/.tmp 残留')
})

test('overwrite（默认）：内容不一致时备份旧文件再覆盖', () => {
  const root = freshRoot('overwrite')
  const src = makeSource(root)
  const skillRoot = join(root, 'home', '.dsh', 'skills')
  const dest = join(skillRoot, SKILL_NAME)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'a.md'), '用户手改过的内容')
  writeFileSync(join(dest, 'b.md'), 'B')          // 与源一致 → 不该被重写
  const res = ensureSkill({ srcDir: src, skillRoot, mode: 'overwrite' })
  assert.equal(res.state, 'installed')
  assert.deepEqual(res.wrote.sort(), ['SKILL.md', 'a.md'], '只该写"缺失的 SKILL.md"与"内容不同的 a.md"')
  assert.equal(res.backedUp.length, 1, '旧文件必须被备份')
  assert.equal(readFileSync(join(dest, 'a.md'), 'utf8'), 'A', '最后应是随件内容')
  const bak = readdirSync(dest).find((f) => f.startsWith('.a.md.bak-'))
  assert.ok(bak, '应留下 .a.md.bak-<时间戳>')
  assert.equal(readFileSync(join(dest, bak), 'utf8'), '用户手改过的内容', '备份里应是用户那份')
})

test('keep 模式：只补缺失的，不动已有文件', () => {
  const root = freshRoot('keep')
  const src = makeSource(root)
  const skillRoot = join(root, 'home', '.dsh', 'skills')
  const dest = join(skillRoot, SKILL_NAME)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'a.md'), '用户手改过的内容')
  const res = ensureSkill({ srcDir: src, skillRoot, mode: 'keep' })
  assert.equal(res.state, 'installed')
  assert.deepEqual(res.wrote.sort(), ['SKILL.md', 'b.md'], '只补缺失的两件')
  assert.deepEqual(res.kept, ['a.md'])
  assert.equal(readFileSync(join(dest, 'a.md'), 'utf8'), '用户手改过的内容', 'keep 模式绝不覆盖')
})

test('off 模式：什么都不做（连技能根都不碰）', () => {
  const root = freshRoot('off')
  const src = makeSource(root)
  const skillRoot = join(root, 'home', '.dsh', 'skills')
  const res = ensureSkill({ srcDir: src, skillRoot, mode: 'off' })
  assert.equal(res.state, 'off')
  assert.equal(existsSync(skillRoot), false, 'off 模式不该创建技能根')
  assert.ok(MODES.includes('off'))
})

test('dry-run：只报计划、不写盘', () => {
  const root = freshRoot('dryrun')
  const src = makeSource(root)
  const skillRoot = join(root, 'home', '.dsh', 'skills')
  const res = ensureSkill({ srcDir: src, skillRoot, dryRun: true })
  assert.equal(res.state, 'installed')
  assert.deepEqual(res.wrote.sort(), ['SKILL.md', 'a.md', 'b.md'])
  assert.equal(existsSync(join(skillRoot, SKILL_NAME)), false, 'dry-run 不得落盘')
})

test('目标位置是目录时：拒绝覆盖（不是普通文件就不动）', () => {
  const root = freshRoot('dir-target')
  const src = makeSource(root)
  const skillRoot = join(root, 'home', '.dsh', 'skills')
  const dest = join(skillRoot, SKILL_NAME)
  mkdirSync(join(dest, 'a.md'), { recursive: true })   // 占位成目录
  const res = ensureSkill({ srcDir: src, skillRoot })
  assert.equal(res.state, 'failed')
  assert.match(res.reason, /不可安全覆盖/)
})

test('源随件里含子目录：拒收（随件必须是扁平文件集）', () => {
  const root = freshRoot('src-subdir')
  const src = makeSource(root)
  mkdirSync(join(src, 'sub'), { recursive: true })
  const res = readSkillSource(src)
  assert.equal(res.ok, false)
  assert.match(res.reason, /子目录/)
  assert.equal(ensureSkill({ srcDir: src, skillRoot: join(root, 'h', '.dsh', 'skills') }).state, 'failed')
})

test('源随件为空：拒收', () => {
  const root = freshRoot('src-empty')
  const src = join(root, 'empty')
  mkdirSync(src, { recursive: true })
  assert.equal(readSkillSource(src).ok, false)
})

test('源随件不存在：failed 且说明原因，不抛异常', () => {
  const root = freshRoot('src-missing')
  const res = ensureSkill({ srcDir: join(root, 'nope'), skillRoot: join(root, 'h', '.dsh', 'skills') })
  assert.equal(res.state, 'failed')
  assert.match(res.reason, /不存在/)
})

test('技能根形态校验：盘根 / 过浅 / 家目录本身 一律拒绝', () => {
  assert.equal(validateSkillRoot('C:\\').ok, false, '盘根必须拒')
  assert.equal(validateSkillRoot('C:\\skills').ok, false, '过浅必须拒')
  assert.equal(validateSkillRoot('相对/路径').ok, false, '相对路径必须拒')
  const okRoot = join(import.meta.dirname, 'tmp-skill-install', 'shape', '.dsh', 'skills')
  assert.equal(validateSkillRoot(okRoot).ok, true)
})

test('技能根是文件系统根时 ensureSkill 也拒绝（形态校验贯穿两条入口）', () => {
  const root = freshRoot('root-guard')
  const src = makeSource(root)
  const res = ensureSkill({ srcDir: src, skillRoot: 'C:\\' })
  assert.equal(res.state, 'failed')
  assert.match(res.reason, /文件系统根|太浅/)
})

// 清理：node:test 没有全局 after，这里用进程退出兜底（临时目录在 .gitignore 的 test/tmp-* 里）
test('链接解析：普通路径不许判成"经链接解析"（否则自动安装会静默失效）', () => {
  const root = freshRoot('link')
  const skillRoot = join(root, 'home', '.dsh', 'skills')
  const link = linkResolution(skillRoot)          // 目录还不存在，要沿最近的存在祖先判
  assert.equal(link.real !== null, true, '应能核验到真实路径')
  assert.equal(link.differs, false, '普通目录不该被判成链接二次解析')
})

process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ } })
