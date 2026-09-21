// test/persona.test.mjs — 人设段的注入规则（"讲棋前先加载技能"这条什么时候出现）
//
// 这条规则的语义边界就是本文件的全部内容：
//   · 技能**确实可用**时才注入 → 不然就是在要求模型加载一个不存在的东西；
//   · autoInstallSkill:false 时既不装、也不注入；
//   · 触发面只在"讲棋/复盘"类请求（这条由人设文字限定，这里断言文字里写明了边界）。
// 用例全部把 DSH_HOME 指到临时目录，绝不碰真实的 ~/.dsh/skills。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildPersona, ensureSkillForPersona, apply, Config, DEFAULT_CONFIG } from '../index.mjs'
import { SKILL_NAME } from '../src/skill-install.js'

const TMP = join(import.meta.dirname, 'tmp-persona')
const CFG = { ...DEFAULT_CONFIG }

function freshHome(tag) {
  const home = join(TMP, tag)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  return home
}

const withHome = (home, fn) => {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return fn() } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
}

test('人设：没有技能状态时不提技能（回归：旧行为一字不变）', () => {
  const p = buildPersona(CFG)
  assert.ok(p.includes('DeepGo Sensei'))
  assert.ok(!p.includes(SKILL_NAME), '还没确认技能可用时，不该出现技能名')
  assert.ok(!p.includes('讲棋前先加载技能'))
})

test('人设：required=false 时同样不提技能', () => {
  const p = buildPersona(CFG, { required: false, name: SKILL_NAME })
  assert.ok(!p.includes(SKILL_NAME))
})

test('人设：required=true 时注入第 8 条，并写明触发边界与五段结构', () => {
  const p = buildPersona(CFG, { required: true, name: SKILL_NAME })
  assert.ok(p.includes('讲棋前先加载技能'))
  assert.ok(p.includes(SKILL_NAME), '必须点名技能名，否则模型不知道加载哪个')
  assert.ok(p.includes('为什么不好'), '要写清哪类请求才要求加载')
  assert.ok(p.includes('不需要'), '要写清哪些情况不要求加载（纯查谱/数值/出图）')
  // 原来的 7 条一条都不能丢
  for (const n of ['1.', '2.', '3.', '4.', '5.', '6.', '7.']) assert.ok(p.includes(`\n${n} `), `缺第 ${n} 条`)
})

test('Config：autoInstallSkill 默认 true（走真校验器填默认值）', () => {
  assert.equal(DEFAULT_CONFIG.autoInstallSkill, true)
  const filled = Config({})
  assert.equal(filled.autoInstallSkill, true, 'schema 校验后应填成 true')
  assert.equal(Config({ autoInstallSkill: false }).autoInstallSkill, false, '显式关掉要保留')
})

test('autoInstallSkill=false：既不装技能，也不注入第 8 条', () => {
  const home = freshHome('off')
  withHome(home, () => {
    const skill = ensureSkillForPersona({ ...CFG, autoInstallSkill: false })
    assert.equal(skill.required, false)
    assert.equal(skill.state, 'off')
    assert.equal(existsSync(join(home, 'skills')), false, '关掉后不该创建技能根')
    assert.ok(!buildPersona(CFG, skill).includes(SKILL_NAME))
  })
})

test('默认（开）：加载期真的把随件装进 <DSH_HOME>/skills，并据此注入第 8 条', () => {
  const home = freshHome('on')
  withHome(home, () => {
    const skill = ensureSkillForPersona(CFG, () => {})
    assert.equal(skill.required, true, '空环境下应装成并判定可用')
    assert.ok(existsSync(join(home, 'skills', SKILL_NAME, 'SKILL.md')), 'SKILL.md 必须落在技能根')
    assert.ok(existsSync(join(home, 'skills', SKILL_NAME, 'BOUNDARIES.md')))
    assert.ok(buildPersona(CFG, skill).includes(SKILL_NAME))
  })
})

test('幂等：第二次加载不再写盘（人设仍注入）', () => {
  const home = freshHome('twice')
  withHome(home, () => {
    ensureSkillForPersona(CFG, () => {})
    const second = ensureSkillForPersona(CFG, () => {})
    assert.equal(second.state, 'up-to-date')
    assert.equal(second.required, true)
  })
})

test('apply()：装成后挂出的人设段里带第 8 条，且顺序与名字不变', () => {
  const home = freshHome('apply')
  withHome(home, () => {
    const sections = []
    const registered = []
    const ctx = {
      systemPrompt: {
        getSectionOrder() { throw new Error('no such section') },   // 走兜底分支
        section(s) { sections.push(s) },
      },
      tools: { register(def) { registered.push(def) } },
      // 路由/监听注册都收在 ctx.effect 里（插件卸载时回收）——桩必须实现它，
      // 否则 apply 会在 registerPanelRoute 上抛 "ctx.effect is not a function"。
      effect(fn) { return fn() },
      // ctx.on(...) 自带 fiber 释放，桩给个可调用且可注销的空实现即可
      on() { return () => {} },
      logger: { info() {} },
      // webServer / sandboxPolicy 都不给：apply 里对它们是可选依赖（走 ctx.get）
      get() { return undefined },
    }
    apply(ctx, { ...CFG })
    assert.ok(registered.length > 0, '工具注册不受影响')
    const persona = sections.find((s) => s.name === 'go-sensei:persona')
    assert.ok(persona, '人设段必须挂上')
    assert.equal(persona.order, 1, '拿不到 DEPLOYMENT_PERSONA_PREFIX 时兜底为 1')
    assert.ok(persona.text.includes(SKILL_NAME), '技能可用时人设里应要求先加载')
    const guidance = sections.find((s) => s.name === 'tool:go-sensei')
    assert.ok(guidance && guidance.order === 3000, '工具指引段不受影响')
  })
})

process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ } })
