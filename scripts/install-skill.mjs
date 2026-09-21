#!/usr/bin/env node
// install-skill.mjs —— 把插件随件里的「围棋详细讲解」技能装进 DSH 技能根
//
// 为什么需要这一步：插件随件（package.json 的 files 里含 skills/）只是把文件放进了 npm 包，
// 而 DSH 运行时是从**技能根**（<DSH_HOME>/skills）读技能的。两处不是同一个地方
// （手册 A-133 家族：同一事实的每个位置都是独立失效点）⇒ 用本脚本做一次显式搬运，
// 并把「源/目标」都打印出来，便于复核到底装的是哪一份。
//
// 用法：
//   node scripts/install-skill.mjs              # 装到默认技能根（$DSH_HOME/skills 或 ~/.dsh/skills）
//   node scripts/install-skill.mjs --dry-run    # 只看会写什么，不落盘
//   node scripts/install-skill.mjs --force      # 目标已存在时覆盖（默认拒绝，避免悄悄改掉你手改过的版本）
//   node scripts/install-skill.mjs --root <dir> # 指定技能根
//   node scripts/install-skill.mjs --allow-link # 技能根（或其最近的存在祖先）经链接二次解析时，显式放行
//
// 安全口径（DeepSec 两轮复核后加固，逐条可核）：
//   ① 技能根须为绝对路径、深度 ≥2、不得是文件系统根、不得是家目录本身 —— 防 `--root /` 写到盘根；
//   ② 链接二次解析**不静默穿透**：技能根即使尚不存在，也沿"最近的存在祖先"取 realpath 比对，
//      不一致就打印真实路径并要求 `--allow-link`（Windows 上按大小写不敏感比对，防路径大小写误报）；
//   ③ 源随件**递归**扫描：任何符号链接（含根目录自身）、任何子目录一律拒收（随件是扁平的文件集）；
//   ④ 目标路径上已存在的符号链接/硬链接/特殊文件一律拒写；写入走**两段式**：
//      先把已有目标原子挪走备份 → 用 `wx`（O_EXCL）新建临时文件（名字已被占用即失败，不穿链接）
//      → rename 到最终名（rename 替换目录项，不顺着链接写）→ **写后回读，与写入前固化的源摘要比全量 SHA256**；
//      任一步失败即回滚（删本次写入、还原备份）。
//   ⑤ `--root` 缺参数/空串 / 路径非法 / `DSH_HOME` 为相对路径 / IO 出错都给一行结论 + 退出码，不吐栈。
//
// 已知残留（**接受并记录**，不宣称已解决）：
//   · 校验与写入之间仍有极窄的 TOCTOU 窗口（单用户、脚本由使用者显式调用、目标在自己技能根内）；
//   · 不校验目标目录的权限位与属主（随件是普通文本，Windows 上无语义；POSIX 下写入模式由 umask 决定）；
//   · `--allow-link` 放行 realpath 不可核验的路径时，**不**断言"目标在技能根内"（运行输出里会明说）。
//
// 退出码：0 = 装成；1 = 出错；2 = 用法错误；3 = 目标已存在且未加 --force（本次**未安装**）。
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'go-detailed-explanation';
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'skills', SKILL_NAME);
const USAGE_HINT = '用法：node scripts/install-skill.mjs [--dry-run] [--force] [--root <dir>] [--allow-link]';
const WIN = process.platform === 'win32';

function fail(msg, code = 1) {
  // 统一出口都过一遍控制字符清洗：随件文件名/路径若含 ANSI 转义或双向控制符，
  // 会把终端文案顶掉或视觉反转（日志伪造）。所有 stderr 走这里，不另开 printf。
  const s = esc(msg);
  console.error(s.startsWith('🔴') ? s : `🔴 ${s}`);
  process.exit(code);
}

// 取 lstat，不存在就返回 null —— **不要用 existsSync 代替**：悬空符号链接 existsSync 返回 false，
// 于是"已存在链接一律拒写"的检查会被绕过，随后的写入会顺着那个链接在别处造出文件。
function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

// 打印前清洗**不可见格式字符**：ANSI 转义能顶掉终端文案；双向控制符（U+202A–202E / U+2066–2069）
// 与 LRM/RLM/ALM（U+200E/U+200F/U+061C）能让路径在终端里视觉反转、伪造"看起来在技能根内"。
function esc(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
    .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, '?');
}

// 目标是不是"非目录的文件节点"：普通文件之外还要防**硬链接**（lstat 看不出硬链接，
// 只有 nlink>1 才是线索）——硬链接写下去会改到技能根之外的同一个 inode。
function fileNodeProblem(p) {
  const st = lstatOrNull(p);
  if (!st) return null;
  if (st.isSymbolicLink()) return '符号链接（含悬空链接）';
  if (st.isDirectory()) return '目录';
  if (!st.isFile()) return '特殊文件（设备/管道等）';
  if (st.nlink > 1) return `硬链接（nlink=${st.nlink}）`;
  return null;
}

// 路径同一性：Windows 大小写不敏感（realpath 返回的大小写常与传入不同，直比会误报）
function samePath(a, b) {
  const x = resolve(a); const y = resolve(b);
  return WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}
function insideOf(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
// 沿"最近的存在祖先"取 realpath —— 技能根尚不存在时也能判链接穿透。
// **无法判定时返回 real: null，调用方必须 fail-closed**（不能把"没查出来"当成"没问题"）。
function realpathOfNearestExisting(p) {
  let cur = resolve(p);
  for (let i = 0; i < 64; i++) {
    if (existsSync(cur)) {
      try { return { anchor: cur, real: realpathSync(cur) }; } catch { return { anchor: cur, real: null }; }
    }
    const up = dirname(cur);
    if (up === cur) return { anchor: cur, real: null };
    cur = up;
  }
  return { anchor: resolve(p), real: null };
}

function parseArgs(argv) {
  const out = { dryRun: false, force: false, allowLink: false, root: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--allow-link') out.allowLink = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--root') {
      const v = argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) fail(`--root 缺参数或为空。\n   ${USAGE_HINT}`, 2);
      out.root = v;
    } else fail(`不认识的参数：${a}\n   ${USAGE_HINT}`, 2);
  }
  return out;
}

// ① 技能根形态校验
function validateRoot(raw) {
  if (!isAbsolute(raw)) fail(`技能根必须是绝对路径（收到 ${raw}）—— 相对路径会随工作目录漂移`);
  const abs = resolve(raw);
  if (abs.length > 4096) fail('技能根路径过长（>4096）');
  if (abs.includes('\0')) fail('技能根含非法字符 NUL');
  const par = parse(abs);
  if (par.root === abs) fail(`拒绝：技能根解析为文件系统根（${abs}）—— 那会往盘根写目录`);
  const depth = abs.slice(par.root.length).split(sep).filter(Boolean).length;
  if (depth < 2) fail(`拒绝：技能根太浅（${abs}）—— 至少要有两级目录，例如 C:\\Users\\你\\.dsh\\skills`);
  if (samePath(abs, homedir())) fail(`拒绝：技能根是家目录本身（${abs}）—— 会往家目录里撒文件`);
  return abs;
}

function sha(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
// 展示口径：只打印前 12 位（人眼对照）；**相等判定用全量摘要**（见 writeAll 的复验段）
const sha12 = (p) => sha(p).slice(0, 12);

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n'));
    return 0;
  }

  if (!existsSync(SRC)) fail(`随件目录不存在：${SRC}\n   本脚本应位于 <包>/scripts/ 下（从源码目录跑）`);
  if (lstatSync(SRC).isSymbolicLink()) fail(`随件根目录本身是符号链接，拒绝安装：${SRC}`);
  const srcReal = realpathSync(SRC);

  // DSH_HOME 也必须绝对：相对路径按 cwd 解析会与"拒绝相对路径以免漂移"的口径自相矛盾
  if (process.env.DSH_HOME && !isAbsolute(process.env.DSH_HOME)) {
    fail(`DSH_HOME 必须是绝对路径（收到 ${process.env.DSH_HOME}）—— 否则技能根会随工作目录漂移`);
  }
  const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh');
  const root = validateRoot(a.root || join(home, 'skills'));
  const dest = join(root, SKILL_NAME);

  // ② 链接二次解析：技能根不存在时，也沿"最近的存在祖先"判（防父级链接静默穿透）
  const { anchor, real } = realpathOfNearestExisting(root);
  const declaredAnchorReal = realpathOfNearestExisting(anchor).real;
  let linkNote = '';
  if (real === null || declaredAnchorReal === null) {
    // fail-closed：解不出真实路径就不写（"没查出来"≠"没问题"）
    if (!a.allowLink) {
      fail(`无法核验技能根 ${root} 的真实路径（realpath 解析失败或上溯到盘根仍不存在）——\n`
        + '   未加 --allow-link 时拒绝写入。若你确信该路径可用，加 --allow-link 重跑。');
    }
    linkNote = '（真实路径未能核验，已按 --allow-link 放行）';
  } else if (!samePath(real, anchor)) {
    linkNote = `（${esc(anchor)} 实际指向 ${esc(real)}）`;
    if (!a.allowLink) {
      console.error(`⚠ 技能根所在位置经链接二次解析：\n   声明 ${esc(anchor)}\n   实际 ${esc(real)}`);
      fail('未加 --allow-link 时拒绝写入（避免写到你没预期的地方）。确认无误后重跑并加 --allow-link。');
    }
  }

  // ③ 源随件递归扫描：符号链接、硬链接、子目录一律拒收（与目标侧检查对称）
  const files = [];
  const walk = (dir, rel = '') => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) fail(`随件里含符号链接，拒绝安装：${esc(join(rel, f))}`);
      if (st.isDirectory()) fail(`随件里含子目录，拒绝安装：${esc(join(rel, f))}（随件应是扁平的文件集）`);
      if (st.isFile() && st.nlink > 1) fail(`随件里含硬链接（nlink=${st.nlink}），拒绝安装：${esc(join(rel, f))}`);
      if (st.isFile()) files.push(f);
    }
  };
  walk(SRC);
  if (!files.length) fail(`随件目录里没有普通文件：${esc(SRC)}`);

  console.log(`技能名     ${SKILL_NAME}`);
  console.log(`源（随件） ${esc(srcReal)}`);
  console.log(`目标       ${esc(dest)}${linkNote}`);
  console.log(`待装文件   ${files.length} 个：${files.map(esc).join('、')}`);

  // ④ 目标已存在：是链接/硬链接/特殊文件就拒；是目录且未加 --force 就拒
  const destSt = lstatOrNull(dest);
  if (destSt) {
    if (destSt.isSymbolicLink()) fail(`目标 ${esc(dest)} 是符号链接（含悬空链接）—— 拒绝穿透写入`);
    if (!destSt.isDirectory()) fail(`目标 ${esc(dest)} 已存在且不是目录 —— 拒绝覆盖`);
    if (!a.force) {
      console.log('\n⚠ 目标已存在，未覆盖（默认不覆盖，避免悄悄改掉你手改过的版本）。');
      console.log('  要看差异请自行 diff；确认要覆盖加 --force。');
      console.log('  （本次**未安装**——退出码 3，便于脚本/CI 区分"装成了"与"什么都没做"。）');
      return 3;
    }
  } else {
    const rootSt = lstatOrNull(root);
    if (rootSt && rootSt.isSymbolicLink()) fail(`技能根 ${esc(root)} 是符号链接 —— 拒绝穿透写入`);
  }

  if (a.dryRun) { console.log('\n（--dry-run：未写盘）'); return 0; }

  mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const to = join(dest, f);
    const why = fileNodeProblem(to);
    if (why) fail(`目标文件不可安全覆盖（${why}），拒绝写入：${esc(to)}`);
  }

  const destReal = realpathSync(dest);
  const canAssertInside = real !== null && declaredAnchorReal !== null;
  if (canAssertInside && !insideOf(destReal, realpathSync(existsSync(root) ? root : anchor))) {
    fail(`写前断言失败：目标 ${esc(destReal)} 不在声明的技能根之下（${esc(root)}）`);
  }

  // ⑤ 两段式写入（消掉"检查与复制之间被换成链接"的窗口）：
  //    先把已存在的目标**原子挪走**做备份（rename 不解引用目标，链接本身被挪走而不是被穿透），
  //    再写临时文件，最后 rename 到最终名 —— rename 替换的是**目录项**，不会顺着链接写进别处。
  //    临时文件用 `wx`（O_EXCL / CREATE_NEW）建：**名字已存在（含被预先埋成链接）就直接失败**，
  //    不顺着链接写到技能根之外。名字再叠一个随机段，避免同名撞车。
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = new Map();
  const tmps = new Map();
  const written = [];
  const rollback = () => {
    for (const f of written) { try { unlinkSync(join(dest, f)); } catch { /* 留人工查 */ } }
    for (const [f, bak] of backups) { try { renameSync(bak, join(dest, f)); } catch { /* 留人工查 */ } }
    for (const t of tmps.values()) { try { unlinkSync(t); } catch { /* 留人工查 */ } }
    return `（已回滚：删掉本次写入 ${written.length} 个；还原原有文件 ${backups.size} 个）`;
  };

  // 先固化"源"的摘要：复验时与**这份快照**比，而不是重新读源（源在扫描后被替换时也能抓到）
  const srcHash = new Map(files.map((f) => [f, sha(join(SRC, f))]));

  try {
    for (const f of files) {
      const to = join(dest, f);
      if (lstatOrNull(to)) {
        const bak = join(dest, `.${f}.bak-${ts}`);
        if (lstatOrNull(bak)) fail(`备份路径已被占用，拒绝继续：${esc(bak)}`);
        renameSync(to, bak);
        backups.set(f, bak);
      }
    }
    for (const f of files) {
      const tmp = join(dest, `.${f}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
      writeFileSync(tmp, readFileSync(join(SRC, f)), { flag: 'wx' });
      tmps.set(f, tmp);
    }
    for (const f of files) {
      renameSync(tmps.get(f), join(dest, f));
      tmps.delete(f);
      written.push(f);
    }
  } catch (e) {
    fail(`写入失败：${(e && e.message) || e}\n   ${rollback()}`);
  }

  console.log('\n已装入：');
  let bad = 0;
  for (const f of files) {
    const to = join(dest, f);
    const st = lstatOrNull(to);
    const x = srcHash.get(f);
    const y = st && st.isFile() && st.nlink <= 1 ? sha(to) : null;
    const ok = !!y && !!st && st.isFile() && !st.isSymbolicLink() && st.nlink <= 1 && x === y;
    if (!ok) bad++;
    console.log(`  ${ok ? '✔' : '🔴'} ${esc(f).padEnd(20)} ${x.slice(0, 12)}`);
  }
  if (bad) fail(`${bad} 个文件复验不一致（类型/链接/哈希）—— 视为未装成\n   ${rollback()}`);

  // 复验通过：清掉备份
  for (const bak of backups.values()) { try { unlinkSync(bak); } catch { /* 留人工查 */ } }

  console.log('\n✔ 装好了。技能由 DSH 在会话启动时载入（新开会话确认；已开着的会话可重开一个）。');
  if (!canAssertInside) {
    console.log('  注意：技能根真实路径未能核验（--allow-link 放行），**未**断言"目标在技能根内"。');
  }
  console.log('  若技能根里已有同类技能，注意两份会互相抢路由 —— 先想清楚留哪一份。');
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  fail(`${e && e.code ? e.code + ' ' : ''}${(e && e.message) || e}`);
}
