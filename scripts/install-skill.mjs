#!/usr/bin/env node
// install-skill.mjs —— 把插件随件里的「围棋详细讲解」技能装进 DSH 技能根（命令行入口）
//
// 这个文件现在**只是入口**：真正的实现（安全口径、两段式写入、回滚、复验）在
// `src/skill-install.js` —— 因为插件加载时（index.mjs 的 apply）也要装同一份技能，
// 两处若各写一份实现就会静默分叉（"CLI 装好了、插件那条路径没装"）。单一真源。
//
// 为什么还需要这个 CLI：插件的自动安装发生在**加载期**，而技能要在**下一个会话**才出现在
// 技能目录里。想在当前会话就查看/核对装了什么，用这个命令更直接（--dry-run 还能先看计划）。
//
// 用法：
//   node scripts/install-skill.mjs              # 装到默认技能根（$DSH_HOME/skills 或 ~/.dsh/skills）
//   node scripts/install-skill.mjs --dry-run    # 只看会写什么，不落盘
//   node scripts/install-skill.mjs --force      # 目标已存在时覆盖（默认拒绝，避免悄悄改掉你手改过的版本）
//   node scripts/install-skill.mjs --root <dir> # 指定技能根
//   node scripts/install-skill.mjs --allow-link # 技能根经链接二次解析时显式放行
//
// 退出码：0 = 装成；1 = 出错；2 = 用法错误；3 = 目标已存在且未加 --force（本次**未安装**）。
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ensureSkill, inspectSkill, defaultSkillSource, resolveSkillsRoot, resolveDshHome, validateSkillRoot,
  linkResolution, isInside, SKILL_NAME,
} from '../src/skill-install.js'

const USAGE = '用法：node scripts/install-skill.mjs [--dry-run] [--force] [--root <dir>] [--allow-link]'

function fail(msg, code = 1) {
  console.error(msg.startsWith('🔴') ? msg : `🔴 ${msg}`)
  process.exit(code)
}

/** 清洗不可见字符（ANSI 转义 / 双向与零宽控制符）——路径文案不能被"视觉伪造"。 */
function esc(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
    .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, '?')
}

function parseArgs(argv) {
  const out = { dryRun: false, force: false, allowLink: false, root: undefined, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--force') out.force = true
    else if (a === '--allow-link') out.allowLink = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--root') {
      const v = argv[++i]
      if (v === undefined || v === '' || v.startsWith('--')) fail(`--root 缺参数或为空。\n   ${USAGE}`, 2)
      out.root = v
    } else fail(`不认识的参数：${a}\n   ${USAGE}`, 2)
  }
  return out
}

function main() {
  const a = parseArgs(process.argv.slice(2))
  if (a.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'))
    return 0
  }

  const srcDir = defaultSkillSource()
  if (!existsSync(srcDir)) {
    fail(`随件目录不存在：${esc(srcDir)}\n   本脚本应位于 <包>/scripts/ 下（从源码目录跑）`)
  }

  const declaredRoot = a.root || resolveSkillsRoot()
  if (!a.root && resolveDshHome().invalid) {
    fail('DSH_HOME 设了但不是绝对路径 —— 明确拒绝（静默回落到 ~/.dsh 会装到你没预期的位置）。\n'
      + '   要么把 DSH_HOME 改成绝对路径，要么用 --root 显式指定技能根。')
  }
  const shape = validateSkillRoot(declaredRoot)
  if (!shape.ok) fail(`拒绝：${shape.reason}`)
  const skillRoot = shape.abs
  const destDir = join(skillRoot, SKILL_NAME)

  // 链接二次解析：不静默穿透（解不出来就 fail-closed）
  const link = linkResolution(skillRoot)
  let linkNote = ''
  if (link.real === null) {
    if (!a.allowLink) {
      fail(`无法核验技能根 ${esc(skillRoot)} 的真实路径——未加 --allow-link 时拒绝写入。`)
    }
    linkNote = '（真实路径未能核验，已按 --allow-link 放行；**不**断言"目标在技能根内"）'
  } else if (link.differs) {
    linkNote = `（${esc(link.anchor)} 实际指向 ${esc(link.real)}）`
    if (!a.allowLink) {
      console.error(`⚠ 技能根所在位置经链接二次解析：\n   声明 ${esc(link.anchor)}\n   实际 ${esc(link.real)}`)
      fail('未加 --allow-link 时拒绝写入（避免写到你没预期的地方）。确认无误后重跑并加 --allow-link。')
    }
  }

  const info = inspectSkill({ srcDir, skillRoot })
  console.log(`技能名     ${SKILL_NAME}`)
  console.log(`源（随件） ${esc(srcDir)}`)
  console.log(`目标       ${esc(destDir)}${linkNote}`)
  console.log(`现状       ${info.installed
    ? (info.same ? '已是最新（逐件一致）'
      : `已装但有差异：内容不同 ${info.differing.length} 件／缺失 ${info.missing.length} 件／多余 ${info.extra.length} 件`)
    : '尚未安装'}`)

  // 默认不覆盖（旧契约）：目标已存在就退出 3，让调用方能区分"装成了"与"什么都没做"
  if (info.installed && !a.force) {
    console.log('\n⚠ 目标已存在，未覆盖（默认不覆盖，避免悄悄改掉你手改过的版本）。')
    console.log('  要看差异请自行 diff；确认要覆盖加 --force。')
    console.log('  （本次**未安装**——退出码 3。）')
    return 3
  }

  const res = ensureSkill({
    srcDir,
    skillRoot,
    mode: a.force ? 'overwrite' : 'keep',
    dryRun: a.dryRun,
    allowLink: a.allowLink,
    log: () => {},
  })
  if (res.state === 'failed') fail(`安装失败：${esc(res.reason)}`)
  if (a.dryRun) {
    console.log(`\n（--dry-run：未写盘）将写入 ${res.wrote.length} 件：${res.wrote.map(esc).join('、')}`)
    return 0
  }

  // 写后包含断言：目标整体必须在声明的技能根之下
  if (link.real !== null && !isInside(destDir, skillRoot)) {
    fail(`写后断言失败：目标 ${esc(destDir)} 不在声明的技能根之下（${esc(skillRoot)}）`)
  }

  const after = inspectSkill({ srcDir, skillRoot })
  console.log(`\n${res.reason}`)
  if (res.backedUp.length) {
    console.log('备份（内容与随件不同、已被替换的旧文件）：')
    for (const b of res.backedUp) console.log(`  · ${esc(b)}`)
  }
  console.log('逐件校验（SHA256 前 12 位）：')
  let bad = 0
  for (const f of res.wrote) {
    const p = join(destDir, f)
    const digest = existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) : '(不可读)'
    console.log(`  ✔ ${esc(f).padEnd(20)} ${digest}`)
  }
  if (!after.same) {
    bad++
    console.log(`  🔴 复探不一致：内容不同 ${after.differing.length} 件／缺失 ${after.missing.length} 件`)
  }
  if (bad) fail('有文件未通过写后校验 —— 视为未装成')
  console.log('\n✔ 装好了。技能由 DSH 在会话启动时载入（**新开会话**才可见；已开着的会话看不到）。')
  console.log('  若技能根里已有同类技能，注意两份会互相抢路由 —— 先想清楚留哪一份。')
  return 0
}

try {
  process.exit(main())
} catch (e) {
  fail(`${e && e.code ? e.code + ' ' : ''}${(e && e.message) || e}`)
}
