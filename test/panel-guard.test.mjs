// test/panel-guard.test.mjs — 面板路由准入闸门（2026-09 安全复核）
//
// 背景：四条 /go-sensei/* 路由直接挂在 webServer 上（不经过 GUI 的 token/cookie
// 校验），而宿主默认监听 0.0.0.0 —— 实测本机 0.0.0.0:3080，且 node.exe 的入站
// 防火墙规则在 Private 网络上放行。没有闸门时，同网段任何设备都能无凭据调用，
// 其中 /review 与 /diagram 还接受调用方给定的路径。
//
// 本文件锁定闸门的行为（真实实现见 index.mjs 的 panelRejection/deny）：
//   1) connection 服务可用时完全复用它的判断（401/403 原样回传）；
//   2) connection 缺席时退回「仅本机来源」—— 局域网 fail-closed；
//   3) 未通过的请求不得改动任何内部状态（尤其 diagram.base 不能被伪造 Host 污染）；
//   4) /review 有窗口限流与在飞上限，防止把 KataGo 拖成 DoS 靶子。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, Config } from '../index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const NO_ENGINE_CFG = { kataGoPath: '', engineDir: join(here, 'no-such-engine') }

const PANEL_ROUTES = ['/go-sensei/roots', '/go-sensei/focus', '/go-sensei/diagram', '/go-sensei/review']

/** 最小 fs 桩：resolve/stat 正常，readBytes 可选挂起（用来测「在飞请求」上限）。 */
function makeFs({ hang = false } = {}) {
  return {
    async resolve(p, opts = {}) {
      const abs = resolve(opts.cwd ?? process.cwd(), p)
      return { displayPath: abs, targetKey: abs }
    },
    async stat(target) {
      try {
        const info = statSync(target.displayPath)
        return { type: info.isDirectory() ? 'directory' : 'file', size: info.size }
      } catch {
        return undefined
      }
    },
    async readBytes(target) {
      if (hang) return new Promise(() => {})
      return readFileSync(target.displayPath)
    },
  }
}

/**
 * 路由 + apply() 的 ctx 桩。
 * @param {object|null} connection `null` 表示该组合里没有 connection 服务。
 */
function makeCtx({ connection = null, fs = makeFs(), sessions = null } = {}) {
  const routes = []
  const registered = new Map()
  const sections = []
  const listeners = new Map()
  return {
    routes,
    registered,
    sections,
    listeners,
    effect: (fn) => fn(),
    fs,
    tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name) } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} }, getSectionOrder: () => 0 },
    emit() {},
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    logger: { warn() {} },
    get(name) {
      if (name === 'webServer') {
        return {
          host: '127.0.0.1',
          port: 3080,
          register: (route) => {
            routes.push(route)
            return () => {
              const at = routes.indexOf(route)
              if (at >= 0) routes.splice(at, 1)
            }
          },
        }
      }
      if (name === 'sessions' && sessions !== null) return { get: (id) => sessions[id] }
      if (name === 'connection') return connection ?? undefined
      return undefined
    },
  }
}

async function call(route, url, req = {}) {
  let body = ''
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { body = chunk },
  }
  const request = {
    url,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    ...req,
  }
  await route.handler(request, res)
  let parsed = null
  try { parsed = JSON.parse(body) } catch { /* 非 JSON（如 SVG） */ }
  return { status: res.statusCode, body: parsed, headers: res.headers, raw: body }
}

const routeOf = (ctx, path) => ctx.routes.find((r) => r.path === path)
const allow = { requestRejection: () => undefined }

// ---------------------------------------------------------------------------
// connection 缺席：必须 fail-closed
// ---------------------------------------------------------------------------

test('闸门: 没有 connection 服务时，局域网来源在四条路由上都被拒（401）', async () => {
  const ctx = makeCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  assert.equal(ctx.routes.length, 4, '四条面板路由都应注册')
  for (const path of PANEL_ROUTES) {
    const r = await call(routeOf(ctx, path), `${path}?path=x.sgf`, { socket: { remoteAddress: '192.168.31.50' } })
    assert.equal(r.status, 401, `${path} 应拒绝局域网来源`)
    assert.equal(r.body.ok, false, `${path} 应回 JSON 拒绝体`)
  }
})

test('闸门: 没有 connection 服务时，本机来源仍然放行', async () => {
  const ctx = makeCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const r = await call(routeOf(ctx, '/go-sensei/focus'), '/go-sensei/focus')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
})

test('闸门: 没有 connection 服务时，跨站标记的请求被 403 挡下（即便来自本机）', async () => {
  const ctx = makeCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const r = await call(routeOf(ctx, '/go-sensei/focus'), '/go-sensei/focus', {
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' },
  })
  assert.equal(r.status, 403)
})

// ---------------------------------------------------------------------------
// connection 存在：判断权完全交给它（与 GUI 的 /api 同一道闸门）
// ---------------------------------------------------------------------------

test('闸门: connection 判定 401/403 时原样回传，不进入业务逻辑', async () => {
  for (const code of [401, 403]) {
    const ctx = makeCtx({ connection: { requestRejection: () => code } })
    apply(ctx, Config(NO_ENGINE_CFG))
    const r = await call(routeOf(ctx, '/go-sensei/review'), `/go-sensei/review?path=${encodeURIComponent(fixture('real-analysis.sgf'))}`)
    assert.equal(r.status, code)
    assert.equal(r.body.ok, false)
  }
})

test('闸门: connection 放行后正常返回（并拿到真实请求对象）', async () => {
  let seen = null
  const ctx = makeCtx({ connection: { requestRejection: (req) => { seen = req; return undefined } } })
  apply(ctx, Config(NO_ENGINE_CFG))
  const r = await call(routeOf(ctx, '/go-sensei/review'), `/go-sensei/review?path=${encodeURIComponent(fixture('real-analysis.sgf'))}`)
  assert.equal(r.status, 200)
  assert.equal(r.body.data.moveCount, 106)
  assert.ok(seen && seen.headers, 'connection.requestRejection 应收到 Node 请求对象')
})

// ---------------------------------------------------------------------------
// 未通过的请求不得留下副作用
// ---------------------------------------------------------------------------

test('闸门: 被拒请求的伪造 Host 不会污染配图基地址', async () => {
  const ctx = makeCtx({ connection: { requestRejection: () => 403 } })
  apply(ctx, Config(NO_ENGINE_CFG))
  const denied = await call(routeOf(ctx, '/go-sensei/diagram'), `/go-sensei/diagram?path=${encodeURIComponent(fixture('real-analysis.sgf'))}`, {
    headers: { host: 'evil.example' },
  })
  assert.equal(denied.status, 403)

  // 配图工具在**执行时**读 diagram.base；它必须仍是挂载时登记的 host:port。
  const tool = ctx.registered.get('go_draw_diagram')
  const exec = { agent: { session: { header: { cwd: process.cwd() } } }, signal: new AbortController().signal }
  const out = JSON.stringify(await tool.execute({ path: fixture('real-analysis.sgf') }, exec))
  assert.ok(out.includes('127.0.0.1:3080'), '配图链接应指向服务自己的 authority')
  assert.ok(!out.includes('evil.example'), '被拒请求的 Host 不得写进配图链接')
})

test('闸门: ?path 只能读已知工作区之内的文件（包含校验），?cwd 自身不构成依据', async () => {
  const ctx = makeCtx({ connection: allow })
  apply(ctx, Config(NO_ENGINE_CFG))
  const rootsRoute = routeOf(ctx, '/go-sensei/roots')
  assert.deepEqual((await call(rootsRoute, '/go-sensei/roots')).body.roots, [])

  // ① 调用方自造的基准不再放行：它既不是会话根，也不在模型的已知工作区根里
  const given = join(here, 'fixtures')
  const refused = await call(
    routeOf(ctx, '/go-sensei/review'),
    `/go-sensei/review?path=real-analysis.sgf&cwd=${encodeURIComponent(given)}`,
  )
  assert.equal(refused.status, 404, '自造基准不得成为读取依据')
  assert.match(String(refused.body.error), /不在已知工作区/)
  assert.ok(String(refused.body.hint || '').length > 0, '要给出可操作的提示')

  // ② 工作区之外的绝对路径同样被挡
  const outside = resolve(here, '..', '..', '..', 'outside.sgf')
  const refusedAbs = await call(
    routeOf(ctx, '/go-sensei/review'),
    `/go-sensei/review?path=${encodeURIComponent(outside)}`,
  )
  assert.equal(refusedAbs.status, 404)
  assert.match(String(refusedAbs.body.error), /不在已知工作区/)

  // ③ 模型复盘过的棋谱：观察者把它的目录记进 roots 之后，同一份文件就能读了
  //    （这是"工作区之外的棋谱照样能上面板/配图"的保证，不是放水）
  ctx.listeners.get('tools/result')(
    {
      name: 'go_parse_sgf',
      arguments: { path: fixture('real-analysis.sgf') },
      agent: { session: { header: { cwd: given, id: 'sess-1' } } },
    },
    undefined,
  )
  const rootsNow = (await call(rootsRoute, '/go-sensei/roots')).body.roots
  assert.ok(rootsNow.includes(given), '观察者要记下棋谱所在目录')
  const allowed = await call(
    routeOf(ctx, '/go-sensei/review'),
    `/go-sensei/review?path=real-analysis.sgf&cwd=${encodeURIComponent(given)}`,
  )
  assert.equal(allowed.status, 200, '已知根之内的文件照常可读')
  assert.equal(allowed.body.data.moveCount, 106)
})

// ---------------------------------------------------------------------------
// 「正在讲解的局面」按会话分桶：多会话并存时互不串台
// ---------------------------------------------------------------------------

test('闸门: /focus 按会话分桶，两个会话的棋盘互不串台', async () => {
  const ctx = makeCtx({ connection: allow })
  apply(ctx, Config(NO_ENGINE_CFG))
  const focus = routeOf(ctx, '/go-sensei/focus')
  const observe = ctx.listeners.get('tools/result')
  const said = (sessionId, path) => observe(
    { name: 'go_parse_sgf', arguments: { path }, agent: { session: { header: { cwd: here, id: sessionId } } } },
    undefined,
  )

  said('sess-A', fixture('real-analysis.sgf'))
  const a1 = await call(focus, '/go-sensei/focus?session=sess-A')
  assert.equal(a1.status, 200)
  assert.equal(a1.body.focus.seq, 1)

  // B 会话讲另一盘棋：B 拿自己的指针，A 的指针不被顶掉
  said('sess-B', fixture('no-such-game.sgf'))
  const b1 = await call(focus, '/go-sensei/focus?session=sess-B')
  assert.equal(b1.body.focus.seq, 2)
  assert.equal(b1.body.focus.path, fixture('no-such-game.sgf'))
  const a2 = await call(focus, '/go-sensei/focus?session=sess-A')
  assert.equal(a2.body.focus.seq, 1, 'A 会话的指针不该被 B 顶掉')
  assert.equal(a2.body.focus.path, fixture('real-analysis.sgf'))

  // 不带 session（旧客户端/整页视图）仍拿"最近一次"，行为向后兼容
  const latest = await call(focus, '/go-sensei/focus')
  assert.equal(latest.body.focus.seq, 2)

  // 还没讲过棋的会话拿到 null：客户端会跳过，不会误跟别人的局面
  const idle = await call(focus, '/go-sensei/focus?session=sess-C')
  assert.equal(idle.body.focus, null)
})

// ---------------------------------------------------------------------------
// 限流：/review 会启动 KataGo，必须防 DoS
// ---------------------------------------------------------------------------

test('闸门: /review 窗口内超过上限返回 429', async () => {
  const ctx = makeCtx({ connection: allow })
  apply(ctx, Config(NO_ENGINE_CFG))
  const review = routeOf(ctx, '/go-sensei/review')
  const url = `/go-sensei/review?path=${encodeURIComponent(fixture('real-analysis.sgf'))}`
  let last = null
  for (let i = 0; i < 21; i += 1) last = await call(review, url)
  assert.equal(last.status, 429)
  assert.equal(last.body.ok, false)
})

test('闸门: /review 在飞请求超过上限返回 503', async () => {
  const ctx = makeCtx({ connection: allow, fs: makeFs({ hang: true }) })
  apply(ctx, Config(NO_ENGINE_CFG))
  const review = routeOf(ctx, '/go-sensei/review')
  const url = `/go-sensei/review?path=${encodeURIComponent(fixture('real-analysis.sgf'))}`
  // 前两个请求会卡在 readBytes 上（in-flight=2），第三个必须被挡下。
  void call(review, url)
  void call(review, url)
  const third = await call(review, url)
  assert.equal(third.status, 503)
  assert.equal(third.body.ok, false)
})

// ---------------------------------------------------------------------------
// 错误响应不回带服务端内部信息
// ---------------------------------------------------------------------------

test('闸门: 读取失败时回通用文案，不回带原始异常', async () => {
  const ctx = makeCtx({ connection: allow })
  apply(ctx, Config(NO_ENGINE_CFG))
  // 目录而非文件：走 400 分支；关键是不出现内部路径/异常文本。
  const r = await call(routeOf(ctx, '/go-sensei/review'), `/go-sensei/review?path=${encodeURIComponent(here)}`)
  assert.equal(r.status, 400)
  assert.ok(!JSON.stringify(r.body).includes('no-such-engine'), '不应泄露内部配置路径')
})

// ---------------------------------------------------------------------------
// 包含校验的比较必须词法归一化（2026-09 复审）
//
// 只看字符串前缀的话，一个 displayPath 里带 `..` 的路径会"看着在根里、其实在根外"。
// 真实 fs 服务通常返回规范化路径，但校验不能依赖这一点。
// ---------------------------------------------------------------------------

test('闸门: displayPath 里的 .. 段无法绕过包含校验', async () => {
  const raw = process.cwd().split('\\').join('/') + '/test/../../../outside.sgf'
  const sneaky = {
    async resolve() { return { displayPath: raw, targetKey: raw } },
    async stat() { return { type: 'file', size: 3 } },
    async readBytes() { return Buffer.from('(;)') },
  }
  const ctx = makeCtx({ connection: allow, fs: sneaky })
  apply(ctx, Config(NO_ENGINE_CFG))
  const r = await call(routeOf(ctx, '/go-sensei/review'), '/go-sensei/review?path=x.sgf')
  assert.equal(r.status, 404, '词法上"看似在根内"、实际在根外的路径必须被拒')
  assert.match(String(r.body.error), /不在已知工作区/)
})
