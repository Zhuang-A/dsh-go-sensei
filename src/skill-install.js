// src/skill-install.js — 把随件「围棋详细讲解」技能装进 DSH 技能根的**单一真源**
//
// 为什么要有这个模块（而不是把逻辑留在 scripts/install-skill.mjs）：
//   装上技能这件事有两个入口 —— ① 用户在命令行手动跑 scripts/install-skill.mjs；
//   ② 插件加载时（index.mjs 的 apply）自动装。两处若各写一份实现，就会出现
//   "CLI 装好了、插件那条路径没装"或反之的静默分叉。所以核心逻辑只在这里，
//   CLI 与 apply 都调它。（同一条事实两处实现 = 两个独立失效点。）
//
// 设计约束（都是实测踩出来的）：
//   · 源随件必须是**扁平的文件集**：任何符号链接/硬链接/子目录一律拒收。
//   · 目标是技能根，可能已有**用户自己改过**的同名文件：
//        mode 'overwrite' → 逐件备份（<file>.bak-<时间戳>）后覆盖；
//        mode 'keep'     → 只补缺失的，不动已存在的；
//        mode 'off'      → 不做任何事。
//   · 写入走**两段式**：临时文件用 wx（O_EXCL，名字被占即失败，不穿链接）→ rename 到最终名
//     （rename 替换目录项，不顺着链接写）。任一步失败**回滚**（删本次写入、还原备份）。
//   · 写后**与写入前固化的源摘要**比全量 SHA256 —— 源在扫描后被换掉也能抓到。
//   · 不抛异常给调用方去猜：一切失败都收敛成 { state: 'failed', reason }，由调用方决定怎么说。
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 技能名 —— 与随件目录名、技能根下的目录名、SKILL.md 的 frontmatter name 必须一致。 */
export const SKILL_NAME = 'go-detailed-explanation'

/** 安装模式。 */
export const MODES = ['overwrite', 'keep', 'off']

/** 包内随件目录（本模块位于 <包>/src/，随件在 <包>/skills/<name>/）。 */
export function defaultSkillSource() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', SKILL_NAME)
}

/**
 * 解析 DSH 家目录。优先 DSH_HOME（必须绝对），否则 ~/.dsh。
 * `invalid` 为真表示 DSH_HOME 设了但不是绝对路径——**调用方要把它当回事**：
 * CLI 直接报错，插件记一条警告后回落到 ~/.dsh（不能因此让插件起不来）。
 * @returns {{ home: string, from: 'DSH_HOME'|'homedir', invalid: boolean }}
 */
export function resolveDshHome(env = process.env, homeDir = homedir()) {
  const raw = env && env.DSH_HOME ? String(env.DSH_HOME) : ''
  if (raw && isAbsolute(raw)) return { home: resolve(raw), from: 'DSH_HOME', invalid: false }
  if (raw) return { home: join(homeDir, '.dsh'), from: 'homedir', invalid: true }
  return { home: join(homeDir, '.dsh'), from: 'homedir', invalid: false }
}

/** 技能根 = <DSH_HOME>/skills。 */
export function resolveSkillsRoot(env) {
  return join(resolveDshHome(env).home, 'skills')
}

/**
 * 文件摘要。**带大小上限**：超过上限不读、返回 null（调用方把 null 当"不一致"处理）。
 * 为什么不直接读：目标侧的文件是用户的，我们不能因为一个 2GB 的同名文件就把内存吃光
 * —— 与源侧的大小上限保持对称。
 */
function sha256file(p) {
  const st = lstatOrNull(p)
  if (!st || !st.isFile() || st.size > MAX_SKILL_FILE_BYTES) return null
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function lstatOrNull(p) {
  try { return lstatSync(p) } catch { return null }
}

/** 路径同一性：Windows 大小写不敏感（realpath 返回的大小写常与传入不同，直比会误判）。 */
function samePath(a, b) {
  const x = resolve(a); const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** 错误信息只留一行、清洗不可见字符、截断 —— 回显给用户就够了，不带控制符也不带栈。 */
function brief(msg, max = 200) {
  const s = String(msg == null ? '' : msg)
    .split('\n')[0]
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
    .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, '?')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 目标是不是"不可安全覆盖的文件节点"（返回原因字符串，或 null）。 */
function unsafeNode(p) {
  const st = lstatOrNull(p)
  if (!st) return null
  if (st.isSymbolicLink()) return '符号链接'
  if (!st.isFile()) return '非普通文件'
  if (st.nlink > 1) return `硬链接（nlink=${st.nlink}）`
  return null
}

/**
 * 读源随件：只要文件，拒链接/硬链接/子目录。
 * @returns {{ ok: true, files: string[], hashes: Map<string,string> } | { ok: false, reason: string }}
 */
/** 单个随件文件的大小上限：随件是几万字的教学文本，超过它就不是我们要装的东西了。 */
const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024

export function readSkillSource(srcDir) {
  try {
    if (!existsSync(srcDir)) return { ok: false, reason: `随件目录不存在：${srcDir}` }
    if (lstatSync(srcDir).isSymbolicLink()) return { ok: false, reason: `随件目录是符号链接：${srcDir}` }
    const files = []
    for (const f of readdirSync(srcDir)) {
      const p = join(srcDir, f)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) return { ok: false, reason: `随件里含符号链接：${f}` }
      if (st.isDirectory()) return { ok: false, reason: `随件里含子目录：${f}（随件应是扁平文件集）` }
      if (!st.isFile()) return { ok: false, reason: `随件里含非普通文件：${f}` }
      if (st.nlink > 1) return { ok: false, reason: `随件里含硬链接：${f}` }
      if (st.size > MAX_SKILL_FILE_BYTES) {
        return { ok: false, reason: `随件文件过大（${f}：${st.size} 字节 > ${MAX_SKILL_FILE_BYTES}）` }
      }
      files.push(f)
    }
    if (!files.length) return { ok: false, reason: `随件目录为空：${srcDir}` }
    const hashes = new Map(files.map((f) => [f, sha256file(join(srcDir, f))]))
    return { ok: true, files, hashes }
  } catch (e) {
    // 读盘异常（EACCES/EPERM 等）也必须收敛成"源不可用"，不能把异常抛给调用方
    return { ok: false, reason: `读取随件失败：${brief(e && e.message)}` }
  }
}

/**
 * 探测技能根里的现状（只读，不改任何东西）。
 * @returns {{
 *   name: string, skillRoot: string, destDir: string, sourceDir: string,
 *   installed: boolean,             // 目标目录里是否有 SKILL.md
 *   sourceUsable: boolean, sourceReason: string,
 *   same: boolean|null,             // 与随件逐件一致？（源不可用或未装时为 null）
 *   differing: string[], missing: string[], extra: string[],
 * }}
 */
export function inspectSkill(o = {}) {
  const srcDir = o.srcDir || defaultSkillSource()
  const skillRoot = o.skillRoot || resolveSkillsRoot()
  const destDir = join(skillRoot, SKILL_NAME)
  const base = {
    name: SKILL_NAME, skillRoot, destDir, sourceDir: srcDir,
    installed: false, sourceUsable: false, sourceReason: '',
    same: null, differing: [], missing: [], extra: [],
  }
  try {
    const src = readSkillSource(srcDir)
    base.sourceUsable = src.ok
    base.sourceReason = src.ok ? '' : src.reason
    base.installed = !!lstatOrNull(join(destDir, 'SKILL.md'))
    if (!base.installed) return base
    const destFiles = existsSync(destDir)
      ? readdirSync(destDir).filter((f) => {
        const st = lstatOrNull(join(destDir, f))
        return !!st && st.isFile()
      })
      : []
    if (!src.ok) { base.extra = destFiles; return base }
    for (const f of src.files) {
      const st = lstatOrNull(join(destDir, f))
      if (!st) { base.missing.push(f); continue }
      if (unsafeNode(join(destDir, f))) { base.differing.push(f); continue }
      if (sha256file(join(destDir, f)) !== src.hashes.get(f)) base.differing.push(f)
    }
    base.extra = destFiles.filter((f) => !src.files.includes(f))
    base.same = base.differing.length === 0 && base.missing.length === 0
    return base
  } catch (e) {
    // 探测失败也不抛：调用方只想知道"能不能用"，不想接异常
    base.sourceUsable = false
    base.sourceReason = base.sourceReason || `探测失败：${brief(e && e.message)}`
    return base
  }
}

/**
 * 把随件装进技能根（幂等）。
 *
 * @param {object} o
 * @param {string} [o.srcDir]      随件目录，默认 defaultSkillSource()
 * @param {string} [o.skillRoot]   技能根，默认 resolveSkillsRoot()
 * @param {'overwrite'|'keep'|'off'} [o.mode]  默认 'overwrite'
 * @param {boolean} [o.dryRun]     只算不写
 * @param {(msg: string) => void} [o.log]
 * @returns {{
 *   state: 'up-to-date'|'installed'|'partial'|'off'|'skipped'|'failed',
 *   reason: string, mode: string, skillRoot: string, destDir: string, sourceDir: string,
 *   wrote: string[], backedUp: string[], kept: string[],
 * }}
 */
export function ensureSkill(o = {}) {
  const srcDir = o.srcDir || defaultSkillSource()
  const skillRoot = o.skillRoot || resolveSkillsRoot()
  const mode = o.mode || 'overwrite'
  const dryRun = !!o.dryRun
  const allowLink = !!o.allowLink
  const log = typeof o.log === 'function' ? o.log : () => {}
  const destDir = join(skillRoot, SKILL_NAME)
  const out = {
    state: 'failed', reason: '', mode, skillRoot, destDir, sourceDir: srcDir,
    wrote: [], backedUp: [], kept: [],
  }
  try {
    if (!MODES.includes(mode)) { out.reason = `未知 mode：${mode}`; return out }
    if (mode === 'off') { out.state = 'off'; out.reason = 'autoInstallSkill 关闭，未做任何事'; return out }

    const src = readSkillSource(srcDir)
    if (!src.ok) { out.reason = src.reason; return out }

    // 技能根形态校验：与 CLI **共用同一份** validateSkillRoot（口径不分叉）
    const shape = validateSkillRoot(skillRoot)
    if (!shape.ok) { out.reason = shape.reason; return out }

    // 链接二次解析：祖先可能是 junction/符号链接，mkdirSync recursive 会顺着它建到别处。
    // 插件自动安装这条路径**没有** --allow-link 这种显式放行，所以默认 fail-closed；
    // CLI 想放行就传 allowLink:true（对应 --allow-link）。
    const link = linkResolution(skillRoot)
    if (link.real === null) {
      if (!allowLink) { out.reason = `无法核验技能根的真实路径（realpath 解析失败）：${skillRoot}`; return out }
    } else if (!samePath(link.real, link.anchor)) {
      if (!allowLink) {
        out.reason = `技能根经链接二次解析（${link.anchor} → ${link.real}）；未显式放行，拒绝自动写入`
        return out
      }
    }

    // 目标目录本身不能是符号链接（否则整棵树写到别处）
    const destSt = lstatOrNull(destDir)
    if (destSt && destSt.isSymbolicLink()) { out.reason = `目标目录是符号链接：${destDir}`; return out }
    if (destSt && !destSt.isDirectory()) { out.reason = `目标已存在且不是目录：${destDir}`; return out }
    const rootSt = lstatOrNull(skillRoot)
    if (rootSt && rootSt.isSymbolicLink()) { out.reason = `技能根是符号链接：${skillRoot}`; return out }

    return installPlanned({ src, srcDir, destDir, skillRoot, mode, dryRun, log, out })
  } catch (e) {
    out.state = 'failed'
    out.reason = `安装过程出错：${brief(e && e.message)}`
    return out
  }
}

/** ensureSkill 的内层：规划 + 两段式写入 + 复验 + 回滚（异常由外层收敛）。 */
function installPlanned({ src, srcDir, destDir, mode, dryRun, log, out }) {
  // 决定每个文件：写 / 跳过（keep 模式下已有）
  const plan = []
  for (const f of src.files) {
    const to = join(destDir, f)
    const st = lstatOrNull(to)
    if (st) {
      const why = unsafeNode(to)
      if (why) { out.reason = `目标文件不可安全覆盖（${why}）：${to}`; return out }
      if (sha256file(to) === src.hashes.get(f)) continue           // 内容一致：无事可做
      if (mode === 'keep') { out.kept.push(f); continue }
    }
    plan.push(f)
  }
  if (!plan.length) {
    out.state = 'up-to-date'
    out.reason = src.files.length ? '技能已是最新（逐件内容一致）' : '无需安装'
    return out
  }
  if (dryRun) {
    out.state = 'installed'
    out.reason = `dry-run：将写入 ${plan.length} 件`
    out.wrote = plan
    return out
  }

  // 两段式写入：备份挪走 → wx 临时文件 → rename → 复验 → 回滚
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backups = new Map()
  const tmps = new Map()
  const written = []
  const rollback = () => {
    // 回滚本身也会失败（文件被占用等）——**不能静默吞掉**：那意味着用户的原文件可能没还回去。
    const failed = []
    for (const f of written) {
      try { unlinkSync(join(destDir, f)) } catch (e) { failed.push(`${f}: ${brief(e && e.message, 60)}`) }
    }
    for (const [f, bak] of backups) {
      try { renameSync(bak, join(destDir, f)) } catch (e) { failed.push(`还原 ${f}: ${brief(e && e.message, 60)}`) }
    }
    for (const t of tmps.values()) {
      try { unlinkSync(t) } catch { /* 临时文件删不掉不影响正确性，不必报 */ }
    }
    return failed
  }
  try {
    mkdirSync(destDir, { recursive: true })
    for (const f of plan) {
      const to = join(destDir, f)
      if (lstatOrNull(to)) {
        // 写入点**再查一次**节点类型：规划与写入之间目标可能被换成链接（TOCTOU 收窄，
        // 残留窗口无法在 JS 里彻底消除 —— 但换掉了就直接失败，不会顺着链接写）。
        const why = unsafeNode(to)
        if (why) throw new Error(`写入点复检：目标不可安全覆盖（${why}）：${to}`)
        const bak = join(destDir, `.${f}.bak-${ts}`)
        if (lstatOrNull(bak)) throw new Error(`备份路径已占用：${bak}`)
        renameSync(to, bak)
        backups.set(f, bak)
      }
    }
    for (const f of plan) {
      const tmp = join(destDir, `.${f}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
      writeFileSync(tmp, readFileSync(join(srcDir, f)), { flag: 'wx' })
      tmps.set(f, tmp)
    }
    for (const f of plan) {
      renameSync(tmps.get(f), join(destDir, f))
      tmps.delete(f)
      written.push(f)
    }
    // 复验：与**写入前固化的**源摘要比，且必须是普通文件、非链接、非硬链接
    const bad = []
    for (const f of written) {
      const to = join(destDir, f)
      const st = lstatOrNull(to)
      if (!st || !st.isFile() || st.isSymbolicLink() || st.nlink > 1
        || sha256file(to) !== src.hashes.get(f)) bad.push(f)
    }
    if (bad.length) throw new Error(`复验不一致：${bad.join('、')}`)
  } catch (e) {
    const failed = rollback()
    out.reason = `写入失败并已回滚：${brief(e && e.message)}`
      + (failed.length ? `；**回滚也有 ${failed.length} 项没做成，需要人工看一眼**：${failed.join('；')}` : '')
    return out
  }

  out.state = 'installed'
  out.wrote = written
  out.backedUp = [...backups.values()]
  out.reason = written.length === src.files.length
    ? `已安装 ${written.length} 件${out.backedUp.length ? `（备份旧文件 ${out.backedUp.length} 个）` : ''}`
    : `已补写 ${written.length} 件（保留已有 ${out.kept.length} 件）`
  log(`[go-sensei] 技能 ${SKILL_NAME} ${out.reason} → ${destDir}`)
  return out
}

/** 校验技能根形态（供 CLI 复用，口径与 ensureSkill 内一致）。 */
export function validateSkillRoot(raw) {
  if (!isAbsolute(raw)) return { ok: false, reason: `技能根必须是绝对路径（收到 ${raw}）` }
  const abs = resolve(raw)
  if (abs.length > 4096) return { ok: false, reason: '技能根路径过长（>4096）' }
  if (abs.includes('\0')) return { ok: false, reason: '技能根含非法字符 NUL' }
  const par = parse(abs)
  if (par.root === abs) return { ok: false, reason: `技能根解析为文件系统根（${abs}）` }
  if (abs.slice(par.root.length).split(sep).filter(Boolean).length < 2) {
    return { ok: false, reason: `技能根太浅（${abs}）—— 至少两级目录` }
  }
  if (abs === resolve(homedir()) || samePath(abs, homedir())) {
    return { ok: false, reason: `技能根是家目录本身（${abs}）` }
  }
  return { ok: true, abs }
}

/** 技能根与声明路径是否被链接二次解析（CLI 的 --allow-link 用）。 */
export function linkResolution(skillRoot) {
  const abs = resolve(skillRoot)
  let cur = abs
  for (let i = 0; i < 64; i++) {
    const st = lstatOrNull(cur)
    if (st) {
      let real = null
      try { real = realpathSync(cur) } catch { return { anchor: cur, real: null, differs: true } }
      const same = process.platform === 'win32'
        ? real.toLowerCase() === cur.toLowerCase()
        : real === cur
      return { anchor: cur, real, differs: !same }
    }
    const up = dirname(cur)
    if (up === cur) return { anchor: cur, real: null, differs: true }
    cur = up
  }
  return { anchor: abs, real: null, differs: true }
}

/** 目标是否在技能根之内（写后包含断言用）。`..` 开头必须连着分隔符才算越界，
 *  否则一个叫 `..foo` 的同级目录会被误判成"在外面"（假阴性，虽然 fail-closed 但会误伤）。 */
export function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}
