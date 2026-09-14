// test/client.test.mjs — 客户端 half 测试（React/插槽桩 + 服务端路由）
//
// 客户端 half 已从「自绘 DOM 浮动面板」改为「注册进 composer dock 的插槽组件」，
// 因此这里不再断言 DOM 结构，而是断言：
//   1. 装载协议：ModuleLoader id 与 package.json name 一致，且不声明硬注入；
//   2. 面板注册到 conversation.composer.dock，展开后渲染问题手列表；
//   3. 点某一行调用 inputActions.setDraft（真插入输入框，而非剪贴板）；
//   4. 服务端 /go-sensei/review 路由：正常返回、相对路径、缺参/缺失/目录拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../index.mjs'
import { injectComments } from '../src/sgf.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

// 仓库自带 engine/ 目录（开箱即用的 KataGo）；要测「无引擎」路径必须显式避开它。
const NO_ENGINE_CFG = { kataGoPath: '', engineDir: join(here, 'no-such-engine') }

// ---------------------------------------------------------------------------
// React / ModuleLoader / slots 桩
// ---------------------------------------------------------------------------

function makeReactStub({ withEffects = false } = {}) {
  const hooks = []
  const effects = []
  let cursor = 0
  return {
    hooks,
    effects,
    reset() { cursor = 0; if (withEffects) effects.length = 0 },
    /** 手动跑第 index 个 effect（桩默认不跑，免得轮询定时器在测试里乱窜）。 */
    runEffect(index) {
      assert.ok(effects[index], `第 ${index} 个 effect 不存在`)
      return effects[index].fn()
    },
    api: {
      createElement(type, props) {
        const children = Array.prototype.slice.call(arguments, 2)
        return { __el: true, type, props: props || {}, children }
      },
      useState(initial) {
        const index = cursor++
        // 按**下标**分配：useEffect 会占掉一个游标而不占槽（下面 useEffect 里 cursor++），
        // 于是 hooks 里会留下空洞；用 push 会把这些值塞到错误的下标上（真实 React 不会）。
        if (!(index in hooks)) hooks[index] = initial
        const set = (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }
        return [hooks[index], set]
      },
      useEffect(fn, deps) {
        cursor++
        if (withEffects) effects.push({ fn, deps })
      },
    },
  }
}

function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (node.__el) {
    out.push(node)
    for (const child of node.children) walk(child, out)
  }
  return out
}

function texts(nodes) {
  const out = []
  for (const node of nodes) {
    for (const child of node.children) {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child))
    }
  }
  return out
}

/** 装载 client.js，返回 entry 与测试用的桩对象。 */
function loadClient({ withReact = true, withDocuments = false, withEffects = false, withInject = false, withClipboard = false } = {}) {
  const react = makeReactStub({ withEffects })
  const registered = []
  const injected = []
  const loaded = []
  const documents = []
  const docInjected = []
  const injectDeps = []
  const clipboardWrites = []
  let pendingInject = null
  globalThis.window = {
    __ModuleLoader__: { load(entry) { loaded.push(entry) } },
  }
  const slots = {
    inject(target, callback) {
      if (target === 'sidebar.right.tab.document') docInjected.push(target)
      injected.push(target)
      return callback()
    },
    register(options, component) { registered.push({ options, component }); return () => {} },
  }
  const documentPreviews = { register(definition) { documents.push(definition); return () => {} } }
  const get = (name) => (name === 'slots'
    ? slots
    : name === 'documentPreviews' && withDocuments ? documentPreviews : undefined)
  const ctx = { get, effect: (fn) => fn() }
  if (withInject) {
    // 真实客户端上下文有 inject：服务没出现时它会等，而不是当场返回 undefined
    ctx.inject = (deps, callback) => { injectDeps.push(deps); pendingInject = callback }
  }
  const requireStub = (name) => {
    if (name === 'react' && withReact) return react.api
    throw new Error('module not found: ' + name)
  }
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  // 以函数体执行，模拟宿主 ModuleLoader 调用工厂
  const fn = new Function('window', 'document', 'navigator', source)
  const navigatorStub = withClipboard
    ? { clipboard: { writeText: (text) => { clipboardWrites.push(text); return Promise.resolve() } } }
    : undefined
  fn(globalThis.window, undefined, navigatorStub)
  const entry = loaded[0]
  const plugin = entry.factory(requireStub)
  plugin.apply(ctx)
  /** 模拟依赖到齐：用带该服务的 scoped ctx 跑挂载回调。 */
  const runInject = () => {
    assert.ok(pendingInject, '应通过 ctx.inject 注册了等待回调')
    const scopedGet = (name) => (name === 'documentPreviews' ? documentPreviews : get(name))
    return pendingInject({ get: scopedGet, effect: (fn) => fn() })
  }
  return { entry, plugin, registered, injected, react, documents, docInjected, injectDeps, runInject, clipboardWrites }
}

// ---------------------------------------------------------------------------

test('client: ModuleLoader id 与 package.json name 完全一致', () => {
  const { entry } = loadClient()
  assert.ok(entry, '必须调用 window.__ModuleLoader__.load')
  assert.equal(entry.id, pkg.name)
  assert.equal(typeof entry.factory, 'function')
})

test('client: 工厂返回 Cordis 插件形状（name/apply，且不声明硬注入）', () => {
  const { plugin } = loadClient()
  assert.equal(plugin.name, pkg.name)
  assert.equal(typeof plugin.apply, 'function')
  // 软依赖：缺 slots/react 时静默降级，故不做硬注入，否则整包会永久 pending
  assert.deepEqual(plugin.inject, [])
})

test('client: 三处注册（dock 面板 / 左侧栏图标 / 主区域整页棋盘）', () => {
  const { registered, injected } = loadClient()
  assert.deepEqual(injected, ['conversation.composer.dock', 'sidebar.panellist', 'main'])
  assert.equal(registered.length, 3)
  // ① 输入框下方的面板：只有 composer 系列插槽给 inputActions，插入追问靠它
  assert.equal(registered[0].options.name, 'conversation.composer.dock')
  assert.equal(registered[0].options.id, 'go-sensei-panel')
  assert.equal(typeof registered[0].component, 'function')
  // ② 左侧栏图标位：外壳自己渲染按钮与标签，我们只给图标（叠加注册，不覆盖原生控件）
  assert.equal(registered[1].options.name, 'sidebar.panellist')
  assert.equal(registered[1].options.id, 'go-sensei-board')
  assert.equal(registered[1].options.label, 'Sensei 棋盘')
  // ③ 对应的主区域面板，key 与图标位 id 一致（外壳按 id 把两者对上）
  assert.equal(registered[2].options.name, 'main')
  assert.equal(registered[2].options.key, 'go-sensei-board')
  assert.equal(registered[2].options.key, registered[1].options.id)
})

test('client: 整页棋盘——空状态给两条路，有棋谱时左右排布并同步手数', () => {
  const { registered, react, plugin } = loadClient()
  const { senseiStore, senseiPatch } = plugin.__internals
  const page = registered.find((r) => r.options.name === 'main').component

  // 空状态：说清怎么把棋谱弄进来（dock 读取 / 跟随讲解自动载入）
  senseiPatch({ data: null, upto: 0 })
  react.reset()
  let tree = page({})
  let text = texts(walk(tree)).join('|')
  assert.ok(text.includes('还没有棋谱'), text)
  assert.ok(text.includes('跟随讲解'), text)
  assert.ok(!walk(tree).some((n) => n.type === 'svg' && n.props.className === 'dgs-board'))

  // 有棋谱：棋盘 + 详细列表（含胜率/目差/AI 首选/变化），点一行同步手数
  const board = {
    size: 19,
    moves: [{ c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 }],
    setup: { black: [], white: [] },
  }
  const candidates = [{
    moveNumber: 3, color: 'B', coord: 'dd', coordLabel: 'D16', label: '大恶手', labelKey: 'blunder',
    winrateLoss: 25.5, scoreLoss: 12.3, pv: [{ label: 'Q16', winratePct: 51.2 }, { label: 'D4', winratePct: 48 }],
  }]
  senseiPatch({ data: { path: 'x.sgf', mode: 'analysis', moveCount: 3, candidates, board }, upto: 3 })
  react.reset()
  tree = page({})
  const nodes = walk(tree)
  assert.ok(nodes.some((n) => n.type === 'svg' && n.props.className === 'dgs-board'), '整页里要有棋盘')
  assert.ok(nodes.some((n) => n.props.className === 'dgs-page-body'), '棋盘与详细列表要左右排布')
  text = texts(nodes).join('|')
  assert.ok(text.includes('第 3 手') && text.includes('25.5') && text.includes('12.3'), text)
  assert.ok(text.includes('AI 首选 Q16'), text)
  assert.ok(text.includes('变化：Q16 → D4'), text)

  const row = nodes.find((n) => n.type === 'button' && n.props.className === 'dgs-page-item')
  row.props.onClick()
  assert.equal(senseiStore.upto, 3, '点一行把共享手数设到那一手')

  // 清空，免得影响后续用例
  senseiPatch({ data: null, upto: 0 })
})

test('client: 胜率/目差曲线（黑方视角、缺口断开、可折叠、点击定位）', async () => {
  const loaded = loadClient()
  const { senseiPatch, renderCurve, curveDomain, curveValueText } = loaded.plugin.__internals
  const page = boardPageOf(loaded)

  // 纵轴口径：胜率固定 0~100（50% 是中线）；目差关于 0 对称、取整到 10 目一档
  assert.deepEqual(curveDomain('winrate', [50, 55]).axis, [100, 50, 0])
  assert.deepEqual(curveDomain('score', [1, 2, -3]).axis, [10, 0, -10])
  assert.deepEqual(curveDomain('score', [1, 44]).axis, [50, 0, -50])
  assert.equal(curveDomain('score', []).axis[0], 10, '没有数据时也不能除零，给最小档')
  assert.equal(curveValueText('winrate', 42.25), '42.3%')
  assert.equal(curveValueText('score', 2), '+2.0 目', '正数要带 +（黑领先）')
  assert.equal(curveValueText('score', -3.5), '-3.5 目')
  assert.equal(curveValueText('winrate', null), '—', '缺口如实显示为 —')

  // 曲线本体：缺口处断开成两段折线，而不是把 null 连成一条假直线
  const values = [50, 55, null, 40, 30]
  const chart = renderCurve({
    kind: 'winrate', values, cur: 4,
    marks: [{ n: 4, color: '#d01013' }],
    onSeek: null,
  })
  const chartNodes = walk(chart)
  assert.equal(chartNodes.filter((n) => n.type === 'polyline').length, 2, '缺口处断成两段')
  assert.equal(chartNodes.find((n) => n.props.key === 'cursordot').props.fill, '#e8eaf0', '当前手画游标点')
  assert.ok(chartNodes.some((n) => n.type === 'circle' && n.props.fill === '#d01013'), '问题手在曲线上点面色点')

  // 详情：整页与下方面板都要有两张曲线（用户 2026-09-14：各个视图都要有）
  const board = {
    size: 19,
    moves: [
      { c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 },
      { c: 'W', x: 15, y: 3 }, { c: 'B', x: 3, y: 15 },
    ],
    setup: { black: [], white: [] },
  }
  const candidates = [{
    moveNumber: 4, color: 'W', coord: 'od', coordLabel: 'O16', label: '失误', labelKey: 'mistake',
    winrateLoss: 9, scoreLoss: 5, pv: [],
  }]
  const data = {
    path: 'x.sgf', mode: 'analysis', level: '18K', moveCount: 5, variations: 0,
    candidates, board, curve: { winrate: values, score: [1, 2, null, -3, -4] },
  }
  senseiPatch({ data, upto: 3 })
  loaded.react.reset()
  let tree = page({})
  const pageCharts = walk(tree).filter((n) => n.type === 'svg' && n.props['data-dgs-curve'] !== undefined)
  assert.deepEqual(pageCharts.map((n) => n.props['data-dgs-curve']), ['winrate', 'score'])
  assert.ok(texts(walk(tree)).join('|').includes('胜率曲线（黑方）'), '标题要写明是黑方视角')
  assert.ok(texts(walk(tree)).join('|').includes('目差曲线（正＝黑领先）'))
  assert.ok(texts(walk(tree)).join('|').includes('第 3 手'), '表头显示当前手的数值')

  // 点图上任意位置 → 跳到那一手（与棋盘点交叉点同一种手感）
  const hit = walk(tree).find((n) => n.props.className === 'dgs-chart-hit')
  assert.ok(hit, '曲线要有可点击的定位层')
  hit.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 480 }) }, clientX: 472 })
  assert.equal(loaded.plugin.__internals.senseiStore.upto, 5, '点最右侧应跳到末手')

  // 折叠：点表头收起这一张，另一张不受影响
  loaded.react.reset()
  tree = page({})
  const head = walk(tree).find((n) => n.type === 'button'
    && String(n.props.className || '').includes('dgs-curvehead')
    && texts(walk(n)).join('|').includes('胜率曲线'))
  assert.ok(head, '曲线表头应可点')
  head.props.onClick()
  loaded.react.reset()
  tree = page({})
  assert.deepEqual(
    walk(tree).filter((n) => n.type === 'svg' && n.props['data-dgs-curve'] !== undefined)
      .map((n) => n.props['data-dgs-curve']),
    ['score'],
    '收起胜率曲线后只剩目差曲线',
  )
  assert.ok(texts(walk(tree)).join('|').includes('胜率曲线（黑方） ▸'), '收起态要有展开指示')

  // 下方面板里也要有这两张（面板已经不放棋盘，曲线是它唯一的数据视图）。
  // 顺带验证折叠态是**跨视图共享**的：刚才在整页收起的那一张，面板里同样是收起的。
  const gamePath = fixture('real-analysis.sgf')
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data }) })
  const props = { inputActions: { setDraft() {} } }
  const { registered, react } = loaded
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  react.reset()
  tree = registered[0].component(props)
  assert.deepEqual(
    walk(tree).filter((n) => n.type === 'svg' && n.props['data-dgs-curve'] !== undefined)
      .map((n) => n.props['data-dgs-curve']),
    ['score'],
    '面板继承整页的折叠态（共享状态）',
  )
  // 在面板里展开 → 两张都在
  walk(tree).find((n) => n.type === 'button'
    && String(n.props.className || '').includes('dgs-curvehead')
    && texts(walk(n)).join('|').includes('胜率曲线')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  assert.deepEqual(
    walk(tree).filter((n) => n.type === 'svg' && n.props['data-dgs-curve'] !== undefined)
      .map((n) => n.props['data-dgs-curve']),
    ['winrate', 'score'],
    '面板也要有两条曲线',
  )
  senseiPatch({ data: null, upto: 0, curveWinrate: true, curveScore: true })
})

test('client: 整页排版——棋盘在左、曲线与列表在右、讲解整幅排在底部', () => {
  // 用户 2026-09-14 给了目标排版：重点是棋盘和讲解都要有足够的位置。
  // 这里锁住四块的位置关系，以及撑着这个排版的几条 CSS（讲解保底高度、棋盘受视口高度约束）。
  const loaded = loadClient()
  const { senseiPatch, CSS } = loaded.plugin.__internals
  const page = boardPageOf(loaded)
  const board = {
    size: 19,
    moves: [{ c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 }],
    setup: { black: [], white: [] },
  }
  const candidates = [{
    moveNumber: 3, color: 'B', coord: 'dd', coordLabel: 'D16', label: '大恶手', labelKey: 'blunder',
    winrateLoss: 25.5, scoreLoss: 12.3, pv: [{ label: 'Q16', winratePct: 51.2 }],
  }]
  senseiPatch({
    data: {
      path: 'x.sgf', mode: 'analysis', level: '18K', moveCount: 3, variations: 0, candidates, board,
      curve: { winrate: [50, 55, 40], score: [1, 2, -3] },
      comments: { 3: '这手太急了：右边还没收完就来断。' },
    },
    upto: 3, curveWinrate: true, curveScore: true,
  })
  loaded.react.reset()
  const tree = page({})

  const cls = (n) => String((n && n.props && n.props.className) || '')
  const kids = (n) => ((n && Array.isArray(n.children)) ? n.children : []).filter((c) => c && typeof c === 'object')
  const pick = (nodes, name) => nodes.find((n) => cls(n).split(' ').indexOf(name) >= 0)

  // 页面分块：页头 / 主体 / 底部
  const body = pick(kids(tree), 'dgs-page-body')
  const foot = pick(kids(tree), 'dgs-page-foot')
  assert.ok(body && foot, '主体与底部分成两块')
  assert.deepEqual(kids(body).map(cls), ['dgs-page-board', 'dgs-page-side'], '左＝棋盘列、右＝曲线+问题手列')

  // 左列：棋盘 + 控件条 + 状态行；讲解不再挤在这一列里
  const boardCol = kids(body)[0]
  assert.ok(kids(boardCol).some((n) => n.type === 'svg' && cls(n) === 'dgs-board'), '左列是棋盘')
  assert.ok(pick(kids(boardCol), 'dgs-ctl'), '控件条贴着棋盘下沿')
  assert.ok(pick(kids(boardCol), 'dgs-note'), '实战/AI 首选/后续状态行')
  assert.ok(!pick(walk(boardCol), 'dgs-comment'), '讲解不能挤在棋盘那一列')

  // 右列：两条曲线 + 问题手列表
  const side = kids(body)[1]
  assert.ok(pick(kids(side), 'dgs-curves'), '曲线在右列')
  assert.ok(pick(kids(side), 'dgs-page-list'), '问题手列表在右列')
  assert.deepEqual(
    walk(side).filter((n) => n.type === 'svg' && n.props['data-dgs-curve'] !== undefined)
      .map((n) => n.props['data-dgs-curve']),
    ['winrate', 'score'],
  )

  // 底部整幅：图例 + 手数小结 + 讲解
  assert.ok(pick(walk(foot), 'dgs-key'), '图例在底部')
  assert.ok(texts(walk(foot)).join('|').includes('3 手 · 1 个问题手'), '底部写明手数与问题手数')
  const comment = pick(walk(foot), 'dgs-comment')
  assert.ok(comment && texts(walk(comment)).join('|').includes('这手太急了'), '讲解整幅排在底部')

  // 撑着排版的 CSS：棋盘宽度受视口高度约束、讲解有保底高度、窄屏退回单列
  assert.ok(/\.dgs-page-board \{[^}]*100vh - 340px/.test(CSS), '棋盘宽度要减掉讲解等固定开销')
  assert.ok(CSS.includes('.dgs-page-foot .dgs-comment { min-height: 118px'), '讲解保底高度')
  assert.ok(CSS.includes('@media (max-width: 860px)'), '窄屏退回单列')
  senseiPatch({ data: null, upto: 0 })
})

test('client: 左侧栏图标按外壳给的 size 渲染', () => {  const { registered, react } = loadClient()
  const icon = registered.find((r) => r.options.name === 'sidebar.panellist').component
  react.reset()
  const tree = icon({ size: 20, active: true })
  assert.equal(tree.type, 'svg')
  assert.equal(tree.props.width, 20)
  assert.equal(tree.props.height, 20)
  assert.equal(tree.props.style, undefined)
})

test('client: React 缺席时静默跳过注册（不抛错）', () => {
  assert.doesNotThrow(() => {
    const { registered } = loadClient({ withReact: false })
    assert.equal(registered.length, 0)
  })
})

test('client: 折叠态只渲染标题与展开按钮', () => {
  const { registered, react } = loadClient()
  react.reset()
  const tree = registered[0].component({ inputActions: { setDraft() {} } })
  const all = texts(walk(tree)).join('|')
  assert.ok(all.includes('DeepGo Sensei'), `实际渲染文本：${all}`)
  assert.ok(all.includes('展开'))
  assert.ok(!all.includes('读取问题手'), '折叠时不应渲染主体')
})

test('client: 展开后渲染路径输入框与读取按钮', () => {
  const { registered, react } = loadClient()
  react.reset()
  let tree = registered[0].component({ inputActions: { setDraft() {} } })
  const toggle = walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开'))
  assert.ok(toggle, '存在展开按钮')
  toggle.props.onClick()
  react.reset()
  tree = registered[0].component({ inputActions: { setDraft() {} } })
  const nodes = walk(tree)
  const all = texts(nodes).join('|')
  assert.ok(all.includes('读取问题手'), `实际渲染文本：${all}`)
  const input = nodes.find((n) => n.type === 'input')
  assert.ok(input, '存在路径输入框')
  assert.ok(String(input.props.placeholder).includes('SGF'))
})

test('client: 未载入棋谱时给出跟随开关，并说明棋盘在左侧栏（面板里不再放棋盘）', () => {
  const { registered, react } = loadClient()
  const props = { inputActions: { setDraft() {} } }
  react.reset()
  let tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)

  const all = texts(walk(tree)).join('|')
  assert.ok(all.includes('未载入棋谱'), '应说明还没载入棋谱')
  assert.ok(all.includes('跟随讲解 ✓'),
    `跟随开关在没有棋谱时也要能按：${all.slice(0, 220)} hooks=${JSON.stringify(react.hooks)}`)
  assert.ok(all.includes('左侧栏'), `应说明棋盘在左侧栏整页：${all.slice(0, 240)}`)
  assert.ok(all.includes('跟随讲解已开'), `应给出"跟随会自动带出棋谱"的说明：${all}`)
  assert.equal(
    walk(tree).some((n) => n.type === 'svg' && String(n.props.className || '').includes('dgs-board')),
    false,
    '下方面板不再渲染棋盘（用户 2026-09-14：只保留输入路径读取问题手）',
  )
})

test('client: 手动读取会「认掉」当前指针，旧讲解不再抢走用户选的棋谱', async () => {
  const { registered, react, plugin } = loadClient()
  const gamePath = fixture('real-analysis.sgf')
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, data: { path: gamePath, mode: 'analysis', level: '18K', moveCount: 106, variations: 2, candidates: [], board: null } }),
  })
  // 模拟「已经见过 seq=4 的指针（例如别的会话留下的）但还没应用」
  plugin.__internals.focusPointer.seen = 4
  plugin.__internals.focusPointer.seq = 0

  const props = { inputActions: { setDraft() {} } }
  react.reset()
  let tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(plugin.__internals.focusPointer.seq, 4, '手动读取后应把已见过的指针认成已应用')
})

test('client: 点问题手一行 → inputActions.setDraft（真插入，非剪贴板）', async () => {
  const { registered, react } = loadClient()
  const drafts = []
  const actions = {
    setDraft: (text) => drafts.push(text),
    addAttachments: () => false,
    removeAttachment() {},
    pruneAttachments() {},
    submit() {},
  }

  const gamePath = fixture('real-analysis.sgf')
  const candidates = [
    { moveNumber: 21, color: 'B', coord: 'ff', coordLabel: 'F14', label: '大恶手', winrateLoss: 98.8, scoreLoss: 46.2, pv: [{ label: 'F16', winratePct: 98.9 }] },
    { moveNumber: 23, color: 'B', coord: 'fe', coordLabel: 'F15', label: '大恶手', winrateLoss: 81.3, scoreLoss: 22.1, pv: [{ label: 'F16', winratePct: 99.6 }] },
  ]
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      data: { path: gamePath, mode: 'analysis', level: '18K', moveCount: 106, variations: 2, candidates },
    }),
  })

  const props = { inputActions: actions, useSession: () => ({ header: { cwd: 'C:/dsh/WeiQi' } }) }
  react.reset()
  let tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  react.reset()
  tree = registered[0].component(props)

  const nodes = walk(tree)
  const items = nodes.filter((n) => n.type === 'button' && n.props.className === 'dgs-item')
  assert.equal(items.length, 2, `应渲染 2 个问题手行，实际 ${items.length}`)
  const itemText = items.map((n) => texts(walk(n)).join(' ')).join(' || ')
  assert.ok(itemText.includes('第 21 手') && itemText.includes('F14') && itemText.includes('大恶手'), itemText)
  assert.ok(itemText.includes('98.8'), '应显示胜率差')

  items[0].props.onClick()
  assert.equal(drafts.length, 1, 'setDraft 应被调用一次')
  assert.ok(drafts[0].includes('第 21 手'), drafts[0])
  assert.ok(drafts[0].includes('F14'))
  // 追问语里要带上「画一张变化图」：配图靠模型主动调 go_draw_diagram，
  // 在提问处写明比只写进人设可靠（人设会被长对话稀释）
  assert.ok(drafts[0].includes('画一张变化图'), drafts[0])
  assert.ok(drafts[0].includes('F16'), '含 AI 推荐')
  assert.ok(drafts[0].includes(gamePath), '含棋谱路径')
})

// ---------------------------------------------------------------------------
// 服务端路由：/go-sensei/review
// ---------------------------------------------------------------------------

/** 最小 fs 桩：够 registerPanelRoute 用（resolve/stat/readBytes）。 */
function makeFsStub() {
  return {
    async resolve(p, opts = {}) {
      const abs = resolve(opts.cwd ?? process.cwd(), p)
      return { displayPath: abs, targetKey: abs }
    },
    async stat(target) {
      try {
        const { statSync } = await import('node:fs')
        const info = statSync(target.displayPath)
        return { type: info.isDirectory() ? 'directory' : 'file', size: info.size }
      } catch { return undefined }
    },
    async readBytes(target) {
      const { readFileSync } = await import('node:fs')
      return readFileSync(target.displayPath)
    },
  }
}

/** 路由测试用的完整 ctx 桩：apply() 需要 systemPrompt/tools/fs/on，路由需要 webServer。 */
function makeRouteCtx({ withWebServer = true, sessions = null } = {}) {
  const routes = []
  const registered = new Map()
  const sections = []
  const listeners = new Map()
  return {
    routes,
    registered,
    sections,
    listeners,
    fs: makeFsStub(),
    tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name) } },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      getSectionOrder: () => 0,
    },
    emit() {},
    // tools/result 观察者：记录工具成功的工作区根（供相对路径解析）
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    logger: { warn() {} },
    get(name) {
      if (name === 'webServer' && withWebServer) {
        // 带上真实服务拥有的 host/port：配图工具靠它拼出绝对 URL
        return {
          host: '127.0.0.1',
          port: 3080,
          register: (route) => { routes.push(route); return () => {} },
        }
      }
      // 会话服务：宿主用它按 id 反查工作区根（右侧栏文档给的是会话内相对路径）
      if (name === 'sessions' && sessions !== null) {
        return { get: (id) => sessions[id] }
      }
      return undefined
    },
  }
}

/** 调一次路由处理器，收集响应。 */
async function callRoute(route, url) {
  let body = ''
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { body = chunk },
  }
  await route.handler({ url }, res)
  let parsed = null
  try { parsed = JSON.parse(body) } catch { /* 非 JSON */ }
  return { status: res.statusCode, body: parsed }
}

test('路由: 正常读取真实棋谱并返回问题手（含裁剪字段）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  assert.ok(route, '路由应被注册')
  assert.equal(route.kind, 'exact')

  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(fixture('real-analysis.sgf')))
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.data.moveCount, 106)
  assert.equal(r.body.data.mode, 'analysis')
  assert.equal(r.body.data.level, '18K')
  assert.ok(r.body.data.candidates.length > 0)
  const first = r.body.data.candidates[0]
  for (const key of ['moveNumber', 'color', 'coord', 'coordLabel', 'label', 'winrateLoss', 'scoreLoss', 'pv']) {
    assert.ok(Object.hasOwn(first, key), `候选应含 ${key}`)
  }
  assert.ok(first.pv.length <= 3, 'PV 应裁剪到 ≤3')
})

test('路由: /go-sensei/review 带上逐手曲线（统一黑棋视角）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(fixture('real-analysis.sgf')))
  assert.equal(r.status, 200)
  const curve = r.body.data.curve
  assert.ok(curve, 'payload 要带 curve')
  assert.equal(curve.winrate.length, 106, '每手一个胜率点')
  assert.equal(curve.score.length, 106, '每手一个目差点')

  const first = r.body.data.candidates[0]
  assert.ok(first, '该棋谱应至少有一个问题手')
  // 口径：一律**黑方视角**（WV 是白方视角、DM 是黑方视角、LZ 是落子者视角，
  // 换算只在宿主做一次）。拿固定夹具的两个已知点对拍：
  //   第 1 手后：黑 94.3% / +6.7 目；第 21 手（大恶手）后：黑 1.1% / −14.2 目。
  // 如果哪天口径被写反成白方视角，这两处会立刻变成 5.7 / 98.9。
  assert.equal(curve.winrate[0], 94.3, '第 1 手后黑方胜率（白方视角会是 5.7）')
  assert.equal(curve.score[0], 6.7, '第 1 手后黑方领先 6.7 目（正数＝黑好）')
  assert.equal(curve.winrate[20], 1.1, '第 21 手大恶手后黑方只剩 1.1%')
  assert.equal(curve.score[20], -14.2, '第 21 手后黑落后 14.2 目')
  assert.equal(curve.winrate[105], null, '末手没有可用数据时是 null（曲线在缺口处断开）')
  // 问题手在曲线上的位置必须能对上（画面上点的就是这些手）
  assert.ok(curve.winrate[first.moveNumber - 1] !== null && curve.score[first.moveNumber - 1] !== null)
})

test('路由: /go-sensei/diagram 渲染配图 SVG（含变化图编号与三角标注）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/diagram')
  assert.ok(route, '应注册配图路由')
  assert.equal(route.kind, 'exact')

  const query = '/go-sensei/diagram?path=' + encodeURIComponent(fixture('real-analysis.sgf'))
    + '&move=20&seq=' + encodeURIComponent('Q16,D4,B:R6')
    + '&marks=' + encodeURIComponent('triangle:C10')
    + '&cap=' + encodeURIComponent('第 20 手后的变化')
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { this.body = chunk },
  }
  await route.handler({ url: query, headers: { host: '127.0.0.1:3080' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/svg+xml; charset=utf-8')
  assert.ok(res.body.includes('<svg'), '应返回 SVG 文档')
  assert.ok(res.body.includes('<polygon'), '三角标注')
  assert.ok(/>1<\/text>/.test(res.body) && />2<\/text>/.test(res.body) && />3<\/text>/.test(res.body),
    '变化图 1-2-3 编号')
  assert.ok(res.body.includes('第 20 手后的变化'), '图注')

  // 缺 path → 400；文件不存在 → 404
  const bad = { statusCode: 200, headers: {}, setHeader() {}, end(c) { this.body = c } }
  await route.handler({ url: '/go-sensei/diagram', headers: {} }, bad)
  assert.equal(bad.statusCode, 400)
  const missing = { statusCode: 200, headers: {}, setHeader() {}, end(c) { this.body = c } }
  await route.handler({ url: '/go-sensei/diagram?path=' + encodeURIComponent('no-such-file.sgf'), headers: {} }, missing)
  assert.equal(missing.statusCode, 404)
})

test('工具: go_draw_diagram 返回可在对话里直接嵌入的 Markdown 图片行', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const tool = ctx.registered.get('go_draw_diagram')
  assert.ok(tool, '应注册 go_draw_diagram')
  const exec = {
    agent: { session: { header: { cwd: join(here, 'fixtures') } } },
    signal: undefined,
  }
  const value = await tool.execute({
    path: fixture('real-analysis.sgf'),
    moveNumber: 20,
    sequence: ['Q16', 'D4', 'B:R6'],
    marks: ['triangle:C10', 'label:Q16:A'],
    caption: '黑 1 断之后',
  }, exec)
  assert.ok(value.url.startsWith('http://127.0.0.1:3080/go-sensei/diagram?'), value.url)
  assert.ok(value.markdown.startsWith('![黑 1 断之后]('), value.markdown)
  assert.ok(value.markdown.includes(value.url), 'Markdown 里的 URL 必须与返回的 url 一致')
  assert.equal(value.moveNumber, 20)
  assert.equal(value.size, 19)
  assert.deepEqual(value.numbered, ['1. Q16 黑', '2. D4 白', '3. R6 黑'],
    '第 20 手是白 → 之后轮到黑（第三手另显式写了 B:R6，颜色要照它）')
  assert.deepEqual(value.marks, ['triangle C10', 'label Q16（A）'])
  assert.deepEqual(value.skipped, [])
  // 渲染出的说明里要给出"原样粘贴"这一行（模型靠它把图放进回答）
  const rendered = tool.output.render({}, value).map((b) => b.text).join('\n')
  assert.ok(rendered.includes(value.markdown), 'render 要回显可粘贴的 Markdown 行')

  // 无法解析的项如实报出，不静默丢掉
  const partial = await tool.execute({ path: fixture('real-analysis.sgf'), sequence: ['Q16', 'Q99'] }, exec)
  assert.deepEqual(partial.skipped, ['Q99'])
})

test('工具: 没有 Web 服务器时 go_draw_diagram 如实报错（不编造 URL）', async () => {
  const ctx = makeRouteCtx({ withWebServer: false })
  apply(ctx, Config(NO_ENGINE_CFG))
  const tool = ctx.registered.get('go_draw_diagram')
  await assert.rejects(
    () => tool.execute({ path: fixture('real-analysis.sgf') },
      { agent: { session: { header: { cwd: join(here, 'fixtures') } } } }),
    /没有挂载 Web 服务器/,
  )
})

test('路由: cwd 参数控制相对路径解析基准', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf')
    + '&cwd=' + encodeURIComponent(join(here, 'fixtures')))
  assert.equal(r.status, 200)
  assert.equal(r.body.data.moveCount, 106)
})

test('路由: 缺 path 参数 → 400', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review')
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
})

test('路由: 文件不存在 → 404', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('definitely-missing.sgf'))
  assert.equal(r.status, 404)
  assert.equal(r.body.ok, false)
})

test('路由: 目录而非文件 → 400', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(here))
  assert.equal(r.status, 400)
})

test('路由: webServer 缺席时不注册也不抛错', () => {
  const ctx = makeRouteCtx({ withWebServer: false })
  assert.doesNotThrow(() => apply(ctx, Config(NO_ENGINE_CFG)))
  assert.equal(ctx.routes.length, 0, '无 webServer 时不应注册路由')
  // 无引擎（engineDir 指到不存在的目录）：6 个复盘工具（含 go_draw_diagram）+ 始终注册的 go_engine_info
  assert.equal(ctx.registered.size, 7, '工具仍应照常注册')
})

// ---------------------------------------------------------------------------
// 工作区根的发现：浏览器拿不到会话 cwd（客户端 SessionSnapshot 里没有该字段），
// 因此把模型调用 go_* 工具时的 exec.agent.session.header.cwd 记下来，
// 作为面板相对路径的解析基准。
// ---------------------------------------------------------------------------

test('路由: 用 tools/result 记下的工作区根解析相对路径', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')

  // 记根之前：相对路径解析不到
  const before = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf'))
  assert.equal(before.status, 404, '未记根时相对路径应 404')

  // 模拟模型调用 go_parse_sgf 成功：观察者记住会话 cwd
  const listener = ctx.listeners.get('tools/result')
  assert.equal(typeof listener, 'function', '应订阅 tools/result')
  listener({ name: 'go_parse_sgf', agent: { session: { header: { cwd: join(here, 'fixtures') } } } })

  // 记根之后：同一相对路径命中
  const after = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf'))
  assert.equal(after.status, 200)
  assert.equal(after.body.data.moveCount, 106)

  // /go-sensei/roots 暴露已知根，便于面板展示
  const rootsRoute = ctx.routes.find((r) => r.path === '/go-sensei/roots')
  assert.ok(rootsRoute, '应注册 /go-sensei/roots')
  let body = ''
  await rootsRoute.handler({ url: '/go-sensei/roots' }, { setHeader() {}, end(c) { body = c } })
  const parsed = JSON.parse(body)
  assert.ok(parsed.roots.includes(join(here, 'fixtures')), JSON.stringify(parsed))
})

test('路由: 非 go_ 工具的 tools/result 不会被记根', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const listener = ctx.listeners.get('tools/result')
  listener({ name: 'bash', agent: { session: { header: { cwd: join(here, 'fixtures') } } } })
  const route = ctx.routes.find((r) => r.path === '/go-sensei/roots')
  let body = ''
  await route.handler({ url: '/go-sensei/roots' }, { setHeader() {}, end(c) { body = c } })
  assert.deepEqual(JSON.parse(body).roots, [])
})

test('路由: 观察者抛错不影响工具链路', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const listener = ctx.listeners.get('tools/result')
  // 形状异常（没有 agent）不应抛错
  assert.doesNotThrow(() => listener({ name: 'go_parse_sgf' }))
  assert.doesNotThrow(() => listener(undefined))
})

test('路由: 已知根之下按 basename 有界发现（用户只写 game.sgf 也能命中）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))

  // 记下一个根
  const fixturesDir = join(here, 'fixtures')
  ctx.listeners.get('tools/result')({
    name: 'go_review_moves',
    agent: { session: { header: { cwd: fixturesDir } } },
  })

  // 给 fs 桩补 listDir：模拟根目录下有一个子目录，棋谱在子目录里
  const { readdirSync, statSync } = await import('node:fs')
  ctx.fs.listDir = async (target) => {
    const dir = target.displayPath
    return readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const child = join(dir, entry.name)
      return { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', target: { displayPath: child, targetKey: child } }
    })
  }
  ctx.fs.stat = async (target) => {
    try {
      const info = statSync(target.displayPath)
      return { type: info.isDirectory() ? 'directory' : 'file', size: info.size }
    } catch { return undefined }
  }

  // 纯文件名 + 深度 1 的子目录：应被发现
  const r = await callRoute(ctx.routes.find((x) => x.path === '/go-sensei/review'),
    '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.moveCount, 106)
})

// ---------------------------------------------------------------------------
// 内置棋盘：Host 数据（board 字段 / 讲解指针）、Client 渲染与规则
// ---------------------------------------------------------------------------

/** 数一数渲染出的棋子（棋子的 className 标记了黑白）。 */
function stoneCounts(tree) {
  const nodes = walk(tree)
  const pick = (mark) => nodes.filter((n) => n.type === 'circle'
    && String(n.props.className || '').includes(mark)).length
  return { black: pick('dgs-stone-b'), white: pick('dgs-stone-w') }
}

/** 盘上的两类小标记：问题手色点（圆）与讲解小方点（方）。
 *  只在棋盘 svg 内部计数——图例（dgs-key）里也有同色的小色样，不能算进来。 */
const MARK_FILLS = ['#9b1996', '#d01013', '#c88c32']
function markerCounts(tree) {
  const board = walk(tree).find((n) => n.type === 'svg'
    && String(n.props.className || '').includes('dgs-board'))
  if (board === undefined) return { problems: 0, notes: 0 }
  const nodes = walk(board)
  return {
    problems: nodes.filter((n) => n.type === 'circle' && MARK_FILLS.includes(n.props.fill)).length,
    notes: nodes.filter((n) => n.type === 'rect' && n.props.fill === '#7c8cff').length,
  }
}

/** 盘上的变化图（Lizzieyzy 的 ghost stone）：一颗棋子 + 正中序号。
 *  返回绘制顺序的 [{key, cx, cy, black, alpha, number, numberFill}]。 */
function ghostStones(tree) {
  const nodes = walk(tree)
  const circles = nodes.filter((n) => n.type === 'circle' && /^pv\d+$/.test(String(n.props.key || '')))
  return circles.map((n) => {
    const label = nodes.find((k) => k.props.key === 'pvt' + String(n.props.key).slice(2))
    return {
      key: n.props.key,
      cx: n.props.cx,
      cy: n.props.cy,
      black: n.props.fill === '#141519',
      alpha: n.props.fillOpacity,
      number: label === undefined ? null : label.children.join(''),
      numberFill: label === undefined ? null : label.props.fill,
    }
  })
}

/** 5 手的小局面：最后一手提掉中间的白子，用来验证"棋盘要按规则画"。 */
const CAPTURE_BOARD = {
  size: 19,
  komi: 7.5,
  handicap: 0,
  moves: [
    { c: 'B', x: 2, y: 3 },
    { c: 'W', x: 3, y: 3 },
    { c: 'B', x: 4, y: 3 },
    { c: 'B', x: 3, y: 2 },
    { c: 'B', x: 3, y: 4 },
  ],
  setup: { black: [], white: [] },
}

/**
 * 渲染「左侧栏整页棋盘」。
 *
 * 2026-09-14 起棋盘**只**在整页（sidebar.panellist 对应的 main）与右侧栏文档里：
 * 下方面板（composer dock）只保留"SGF 路径 → 读取问题手 → 插入追问"，
 * 所以盘面相关的用例统一走这里，用 __internals.senseiPatch 直接摆好共享状态。
 */
function boardPageOf(loaded) {
  const page = loaded.registered.find((r) => r.options.name === 'main')
  assert.ok(page, '应注册整页棋盘')
  return page.component
}

test('client: 棋盘纯规则（落子/提子/摆子/坐标换算）', () => {
  const { plugin } = loadClient()
  const { boardAt, boardLabel, parsePointLabel } = plugin.__internals
  assert.equal(typeof boardAt, 'function', '__internals 应暴露棋盘规则供单测')

  assert.equal(boardAt(CAPTURE_BOARD, 4)[3 * 19 + 3], 2, '第 4 手后白子还在')
  assert.equal(boardAt(CAPTURE_BOARD, 5)[3 * 19 + 3], 0, '第 5 手应提掉白子')
  assert.equal(boardAt(CAPTURE_BOARD, 0).filter((v) => v !== 0).length, 0, '开局空盘')

  const handicap = { size: 9, moves: [], setup: { black: [[2, 2], [6, 6]], white: [[4, 4]] } }
  const grid = boardAt(handicap, 0)
  assert.equal(grid[2 * 9 + 2], 1)
  assert.equal(grid[6 * 9 + 6], 1)
  assert.equal(grid[4 * 9 + 4], 2)

  assert.equal(boardLabel(15, 3, 19), 'Q16')
  assert.deepEqual(parsePointLabel('Q16', 19), { x: 15, y: 3 })
  assert.equal(parsePointLabel('I5', 19), null, '字母 I 不是合法列')
  assert.equal(parsePointLabel('K5', 9), null, '9 路只有 A..J，K 列越界')
  assert.deepEqual(parsePointLabel('J9', 9), { x: 8, y: 0 }, '9 路的角点仍要认')
  assert.equal(parsePointLabel('Q20', 19), null, '行号越界')
})

test('client: 路径同一性判断（同名不同盘的棋不能被当成同一盘）', () => {
  const { plugin } = loadClient()
  const { sameFile } = plugin.__internals
  assert.equal(typeof sameFile, 'function', '__internals 应暴露 sameFile')

  assert.equal(sameFile('C:/a/b/game.sgf', 'C:\\a\\b\\game.sgf'), true, '分隔符与大小写无关')
  assert.equal(sameFile('C:/a/b/game.sgf', 'game.sgf'), true, '一方只有文件名时按文件名比')
  assert.equal(sameFile('C:/x/review-check/_accept/game.sgf', 'review-check/_accept/game.sgf'), true,
    '相对路径是绝对路径的后缀')
  assert.equal(sameFile('C:/a/game.sgf', 'D:/b/game.sgf'), false, '同名但不同目录不是同一盘')
  assert.equal(sameFile('', 'game.sgf'), false, '空路径不匹配任何东西')
})

test('client: 棋盘渲染对畸形候选数据不抛错（首选标签解析不出来时）', () => {
  const { plugin, react } = loadClient()
  const { renderBoard } = plugin.__internals
  assert.equal(typeof renderBoard, 'function')

  react.reset()
  // 'pass' / 空标签都解析不出坐标：整块面板不能因此崩掉
  const tree = renderBoard({
    board: CAPTURE_BOARD, upto: 5, problem: null, pv: [null, null], hintLabel: 'pass', onPick: null,
  })
  const nodes = walk(tree)
  assert.ok(nodes.some((n) => n.type === 'svg'), '仍应画出棋盘')
  assert.ok(!nodes.some((n) => n.type === 'rect' && n.props.fill === '#ffc800'), '解析不出坐标时不画信息条')
  assert.ok(!nodes.some((n) => n.type === 'circle' && n.props.stroke === '#0000ff'), '也不画首选蓝圈')
})

test('client: 变化图落在实战已占的点上时不画（免得像把子叠在子上）', () => {
  const { plugin, react } = loadClient()
  const { renderBoard } = plugin.__internals
  const board = {
    size: 9,
    moves: [{ c: 'B', x: 2, y: 2 }],
    setup: { black: [], white: [] },
  }
  react.reset()
  // pv[1] 正落在第 1 手黑子上，pv[2] 是空点
  const tree = renderBoard({
    board, upto: 1, problem: null, hintLabel: '',
    pv: [{ x: 4, y: 4 }, { x: 2, y: 2 }, { x: 5, y: 5 }], onPick: null,
  })
  const ghosts = ghostStones(tree)
  assert.equal(ghosts.length, 1, '只画落在空点上的那一手')
  assert.equal(ghosts[0].cx, 8 + 5 * (84 / 8), '留下的是 pv[2]')
  // 序号不重排：被跳过的仍是变化第 2 手，画出来的是第 3 手；
  // 轮转也不受影响（第 1 手黑 → 第 2 手白被跳过 → 第 3 手仍是黑）
  assert.equal(ghosts[0].number, '3')
  assert.equal(ghosts[0].black, true)
})

test('client: 变化图按轮转分黑白，跳过已占点也不打乱序号与轮转', () => {
  const { plugin } = loadClient()
  const { pvGhostStones } = plugin.__internals
  assert.equal(typeof pvGhostStones, 'function')
  const size = 9
  const empty = new Array(size * size).fill(0)
  // 首选（第 1 手）＋后续三手
  const pv = [{ x: 4, y: 4 }, { x: 5, y: 5 }, { x: 6, y: 6 }, { x: 2, y: 2 }]
  // 第 1 手是黑 → 第 2 手白、第 3 手黑、第 4 手白（Lizzieyzy Branch.java 的轮转口径）
  assert.deepEqual(pvGhostStones(pv, empty, size, 'B'), [
    { x: 5, y: 5, black: false, number: 2 },
    { x: 6, y: 6, black: true, number: 3 },
    { x: 2, y: 2, black: false, number: 4 },
  ])
  // 第 1 手是白（或颜色未知时按黑先）→ 整体反相
  assert.deepEqual(pvGhostStones(pv, empty, size, 'W').map((s) => s.black), [true, false, true])
  assert.deepEqual(pvGhostStones(pv, empty, size, null).map((s) => s.black), [false, true, false])
  // 已占点跳过：跳掉的是白 2，后面画的仍是黑 3（不重排序号、不串色）
  const grid = empty.slice()
  grid[5 * size + 5] = 1
  assert.deepEqual(pvGhostStones(pv, grid, size, 'B'), [
    { x: 6, y: 6, black: true, number: 3 },
    { x: 2, y: 2, black: false, number: 4 },
  ])
  // 只有首选一点（没有后续）时什么都不画
  assert.deepEqual(pvGhostStones([{ x: 4, y: 4 }], empty, size, 'B'), [])
})

test('client: 面板如实显示补算状态（补了多少手 / 失败原因）', async () => {
  const { registered, react } = loadClient()
  const gamePath = fixture('real-analysis.sgf')
  const board = { size: 19, moves: [{ c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }], setup: { black: [], white: [] } }

  const render = async (data) => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data }) })
    const props = { inputActions: { setDraft() {} } }
    react.reset()
    let tree = registered[0].component(props)
    const btn = (label) => walk(tree).find((n) => n.type === 'button' && texts([n]).includes(label))
    if (btn('展开') !== undefined) { btn('展开').props.onClick(); react.reset(); tree = registered[0].component(props) }
    walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
    react.reset()
    tree = registered[0].component(props)
    walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
    await new Promise((r) => setTimeout(r, 30))
    react.reset()
    return texts(walk(registered[0].component(props))).join('|')
  }

  // 补算成功：手数与耗时都要露出来
  const ok = await render({
    path: gamePath, mode: 'analysis', level: '18K', moveCount: 2, variations: 0, candidates: [],
    board, autoEngine: { from: 1, to: 2, moves: 113, seconds: 34.5, engine: 'KataGo' },
  })
  assert.ok(ok.includes('引擎补算 113 手'), ok)
  assert.ok(ok.includes('34.5 秒'), ok)

  // 补算失败：失败原因要露出来，且"没东西可讲"要说清是补算没成功
  const failed = await render({
    path: gamePath, mode: 'theory', level: '18K', moveCount: 2, variations: 0, candidates: [],
    board, autoEngine: { failed: 'subprocess 服务不可用，无法自起 KataGo 补算' },
  })
  assert.ok(failed.includes('补算未成功'), failed)
  assert.ok(failed.includes('subprocess 服务不可用'), failed)
  assert.ok(failed.includes('棋谱没有可用的分析数据，补算也没成功'), failed)

  // 没有补算记录（引擎不可用）：说明这一档只讲棋理
  const theory = await render({
    path: gamePath, mode: 'theory', level: '18K', moveCount: 2, variations: 0, candidates: [], board,
  })
  assert.ok(theory.includes('这一档只能讲棋理'), theory)
})

test('路由: /go-sensei/review 一并返回棋盘数据（尺寸/手顺/摆子）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')

  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(fixture('synthetic-analysis.sgf')))
  assert.equal(r.status, 200)
  const board = r.body.data.board
  assert.ok(board, '应返回 board 字段（客户端画盘只靠它）')
  assert.equal(board.size, 19)
  assert.equal(board.moves.length, r.body.data.moveCount)
  // 首手 B:pd —— SGF 坐标 pd 对应 x=15,y=3，客户端据此落子
  assert.deepEqual(board.moves[0], { c: 'B', x: 15, y: 3 })
  assert.deepEqual(board.setup, { black: [], white: [] })

  const real = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(fixture('real-analysis.sgf')))
  assert.equal(real.status, 200)
  assert.equal(real.body.data.board.moves.length, 106, '手顺长度必须与手数一致')
  assert.ok(real.body.data.players, '面板表头要显示棋手名')
})

test('路由: /go-sensei/focus 跟随讲解（工具调用 -> 局面指针）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const listener = ctx.listeners.get('tools/result')
  const focusRoute = ctx.routes.find((r) => r.path === '/go-sensei/focus')
  assert.ok(focusRoute, '应注册 /go-sensei/focus')

  let r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.ok, true)
  assert.equal(r.body.focus, null, '还没有讲解时指针为空')

  const at = (name, args, extra) => listener({ name, arguments: args, agent: { session: { header: { cwd: 'C:/dsh/WeiQi' } } } }, extra)

  at('go_position_context', { path: 'review-check/_accept/game.sgf', moveNumber: 21 })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.name, 'game.sgf')
  assert.equal(r.body.focus.moveNumber, 21)
  assert.equal(r.body.focus.cwd, 'C:/dsh/WeiQi')
  assert.equal(r.body.focus.kind, 'context')
  assert.equal(r.body.focus.seq, 1)

  // 失败的调用不改变讲解位置（模型试错路径很常见）
  at('go_position_context', { path: 'nope.sgf', moveNumber: 99 }, { isError: true })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.moveNumber, 21)
  assert.equal(r.body.focus.seq, 1)

  // 回写注释：正在讲的位置 = 第一条注释的手数
  at('go_write_review', { path: 'game.sgf', entries: [{ moveNumber: 33, comment: 'x' }, { moveNumber: 47, comment: 'y' }] })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.moveNumber, 33)
  assert.equal(r.body.focus.kind, 'write')
  assert.equal(r.body.focus.seq, 2)

  // 只读棋谱：知道在讲哪一盘，但不知道第几手
  at('go_parse_sgf', { path: 'other.sgf' })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.name, 'other.sgf')
  assert.equal(Object.hasOwn(r.body.focus, 'moveNumber'), false)

  // 非 go_ 工具不碰指针
  listener({ name: 'bash', arguments: { path: 'x.sgf', moveNumber: 1 }, agent: { session: { header: { cwd: 'C:/dsh/WeiQi' } } } })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.name, 'other.sgf')
})

test('client: 载入后停在最严重的问题手（面板只报状态，棋盘在整页）', async () => {
  const { registered, react } = loadClient()
  const gamePath = fixture('real-analysis.sgf')
  const BOARD8 = {
    size: 19,
    moves: [
      { c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 },
      { c: 'W', x: 15, y: 3 }, { c: 'B', x: 3, y: 15 }, { c: 'W', x: 9, y: 9 },
      { c: 'B', x: 2, y: 2 }, { c: 'W', x: 16, y: 16 },
    ],
    setup: { black: [], white: [] },
  }
  // 宿主按严重度排序：[0] = 最严重（第 3 手），第 6 手是次要的一处
  const candidates = [
    { moveNumber: 3, color: 'B', coord: 'dd', coordLabel: 'D16', label: '大恶手', labelKey: 'blunder', winrateLoss: 25, scoreLoss: 12, pv: [{ label: 'Q16', winratePct: 50 }] },
    { moveNumber: 6, color: 'W', coord: 'jj', coordLabel: 'K10', label: '失误', labelKey: 'mistake', winrateLoss: 9, scoreLoss: 5, pv: [] },
  ]
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      data: { path: gamePath, mode: 'analysis', level: '18K', moveCount: 8, variations: 0, candidates, board: BOARD8 },
    }),
  })

  const props = { inputActions: { setDraft() {} } }
  react.reset()
  let tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  react.reset()
  tree = registered[0].component(props)

  // 面板里不再有棋盘，但状态行照旧：自动停在第 3 手（最严重的那一处）而不是末手
  assert.ok(texts(walk(tree)).join('|').includes('第 3/8 手'), '载入后应停在最严重的问题手')
  assert.equal(
    walk(tree).some((n) => n.type === 'svg' && String(n.props.className || '').includes('dgs-board')),
    false,
    '面板不画棋盘',
  )
})

test('client: 整页棋盘——问题点随手数开亮、当前手大圈、恶点跳转', () => {
  const loaded = loadClient()
  const { senseiPatch } = loaded.plugin.__internals
  const page = boardPageOf(loaded)
  const BOARD8 = {
    size: 19,
    moves: [
      { c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 },
      { c: 'W', x: 15, y: 3 }, { c: 'B', x: 3, y: 15 }, { c: 'W', x: 9, y: 9 },
      { c: 'B', x: 2, y: 2 }, { c: 'W', x: 16, y: 16 },
    ],
    setup: { black: [], white: [] },
  }
  const candidates = [
    { moveNumber: 3, color: 'B', coord: 'dd', coordLabel: 'D16', label: '大恶手', labelKey: 'blunder', winrateLoss: 25, scoreLoss: 12, pv: [{ label: 'Q16', winratePct: 50 }] },
    { moveNumber: 6, color: 'W', coord: 'jj', coordLabel: 'K10', label: '失误', labelKey: 'mistake', winrateLoss: 9, scoreLoss: 5, pv: [] },
  ]
  senseiPatch({
    data: { path: 'x.sgf', mode: 'analysis', level: '18K', moveCount: 8, variations: 0, candidates, board: BOARD8 },
    upto: 3,
  })
  loaded.react.reset()
  let tree = page({})

  const nodes = walk(tree)
  const dotOf = (color) => nodes.filter((n) => n.type === 'circle' && n.props.fill === color
    && Math.abs(Number(n.props.r) - 0.16 * (84 / 18)) < 0.001)
  assert.equal(dotOf('#9b1996').length, 1, '大恶手应有一个紫点')
  // 问题点与讲解点同一条规则：只标"已经下到"的（第 6 手那处还没走到，先不点）
  assert.equal(dotOf('#d01013').length, 0, '还没走到的问题手不该先点出来')
  assert.ok(nodes.some((n) => n.type === 'circle' && n.props.stroke === '#9b1996'), '当前这一手还要有大圈')

  // 恶点跳转：下一个 → 下一个（到头绕回第一个）→ 上一个（到头绕回最后一个）
  const clickBtn = (label) => {
    const button = walk(tree).find((n) => n.type === 'button' && texts([n]).includes(label))
    assert.ok(button, `找不到按钮 ${label}`)
    assert.ok(!button.props.disabled, `${label} 不应被禁用（本局有问题手）`)
    button.props.onClick()
    loaded.react.reset()
    tree = page({})
    return texts(walk(tree)).join('|')
  }
  assert.ok(clickBtn('恶点▶').includes('第 6/8 手'), '「恶点▶」应跳到下一处（第 6 手）')
  assert.equal(walk(tree).filter((n) => n.type === 'circle' && n.props.fill === '#d01013').length, 1,
    '走到第 6 手后应出现那一处的红点')
  assert.ok(clickBtn('恶点▶').includes('第 3/8 手'), '最后一处再点应绕回第一处（第 3 手）')
  assert.ok(clickBtn('◀恶点').includes('第 6/8 手'), '第一处再往回点应绕到最后一处（第 6 手）')
  assert.ok(clickBtn('恶点▶').includes('第 3/8 手'), '再点一次回到第 3 手')

  // 拨回开局：盘面回到干净状态（两处问题手都还没走到，不该有残留色点）
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('⏮')).props.onClick()
  loaded.react.reset()
  tree = page({})
  const nodes2 = walk(tree)
  assert.deepEqual(markerCounts(tree), { problems: 0, notes: 0 }, '开局盘面应干净（问题点还没走到）')
  assert.ok(!nodes2.some((n) => n.type === 'circle' && n.props.stroke === '#9b1996'), '大圈只套在当前这一手上')
  assert.ok(texts(nodes2).join('|').includes('盘上色点＝问题手'), '应说明盘上色点的含义')
})

test('client: 整页棋盘——提子、AI 首选与变化图、讲解点、步进', () => {
  const loaded = loadClient()
  const { senseiPatch } = loaded.plugin.__internals
  const page = boardPageOf(loaded)
  const candidates = [{
    moveNumber: 3,
    color: 'B',
    coord: 'ed',
    coordLabel: 'E16',
    label: '失误',
    labelKey: 'mistake',
    winrateLoss: 12.3,
    scoreLoss: 4.5,
    // line ＝ 变化线（第一项是首选自己）：盘上画的是**首选之后的 D4、R6**，
    // 不是这里的第 2 个候选点
    pv: [
      { label: 'Q16', winratePct: 55.5, line: 'Q16 D4 R6' },
      { label: 'C10', winratePct: 48.2, line: 'C10 D4' },
    ],
  }]
  // 面板不再放棋盘：盘面用例直接摆好共享状态、渲染整页棋盘
  senseiPatch({
    data: {
      path: 'game.sgf', mode: 'analysis', level: '18K', moveCount: 5, variations: 0,
      candidates, board: CAPTURE_BOARD,
      players: { black: '甲', white: '乙' },
      // 第 2、4 手有写回的讲解：盘上讲解点必须"下到那一手才亮"
      comments: { 2: '第 2 手的讲解', 4: '第 4 手的讲解' },
    },
    upto: 3,
  })
  loaded.react.reset()
  let tree = page({})
  const svg = walk(tree).find((n) => n.type === 'svg' && n.props.className === 'dgs-board')
  assert.ok(svg, '整页应渲染棋盘')
  assert.equal(svg.props['data-dgs-board'], '19')
  assert.equal(stoneCounts(tree).black, 2, '第 3 手时盘上 2 颗黑子')
  assert.equal(stoneCounts(tree).white, 1)
  const nodes = walk(tree)
  assert.ok(nodes.some((n) => n.type === 'circle' && n.props.stroke === '#d01013'),
    '问题手圆圈按严重度取色（失误 = Lizzieyzy 的 (208,16,19)）')
  const bestRing = nodes.find((n) => n.type === 'circle' && n.props.stroke === '#0000ff')
  assert.ok(bestRing, 'AI 首选应有蓝圈（Lizzieyzy showBlueRing）')
  assert.ok(nodes.some((n) => n.type === 'circle' && n.props.fill === 'rgba(0, 255, 255, 0.5)'),
    'AI 首选应是青色实心圆')
  // Q16 -> x=15,y=3 -> pos = 8 + 15*(84/18) = 78, 8 + 3*(84/18) = 22
  assert.ok(Math.abs(bestRing.props.cx - 78) < 0.01 && Math.abs(bestRing.props.cy - 22) < 0.01,
    `蓝圈应在 Q16（实际 ${bestRing.props.cx},${bestRing.props.cy}）`)
  assert.ok(nodes.some((n) => n.type === 'rect' && n.props.fill === '#ffc800'), '首选点胜率用橙底信息条')
  // 变化图＝首选之后的后续几手（D4、R6），不是第 2、3 个候选点。
  // 画法照 Lizzieyzy 的 ghost stone：一颗半透明棋子 + 正中序号（黑棋白字、白棋黑字）
  const ghosts = ghostStones(tree)
  assert.deepEqual(ghosts.map((n) => n.cx), [8 + 3 * (84 / 18), 8 + 16 * (84 / 18)],
    '变化图应画在 D4、R6（实际 ' + ghosts.map((n) => n.key).join(',') + '）')
  assert.deepEqual(ghosts.map((n) => n.number), ['2', '3'], '序号是变化里的第 2、3 手')
  // 第 3 手是黑 E16 → 变化第 2 手（D4）是白、第 3 手（R6）是黑
  assert.deepEqual(ghosts.map((n) => n.black), [false, true])
  assert.deepEqual(ghosts.map((n) => n.numberFill), ['#111111', '#ffffff'], '数字反色')
  assert.deepEqual(ghosts.map((n) => n.alpha), [0.55, 0.55], '半透明：底下的实战棋子还看得见')
  assert.ok(!nodes.some((n) => n.props.cx === 8 + 2 * (84 / 18) && n.props.cy === 8 + 9 * (84 / 18)),
    '第 2 个候选点 C10 不该上盘')
  const text = texts(nodes).join('|')
  assert.ok(text.includes('AI 首选 Q16'), text)
  assert.ok(text.includes('○ 实战 3 手 E16'), text)
  assert.ok(text.includes('后续：D4 → R6'), '说明行应给出变化图后续：' + text.slice(0, 300))

  // 步进：⏮ 回开局 → ▶ 一手；⏭ 回末手（提子生效，白子消失）
  const click = (label) => {
    const button = walk(tree).find((n) => n.type === 'button' && texts([n]).includes(label))
    assert.ok(button, `找不到按钮 ${label}`)
    button.props.onClick()
    loaded.react.reset()
    tree = page({})
  }
  click('⏮')
  assert.equal(stoneCounts(tree).black + stoneCounts(tree).white, 0, '开局空盘')
  assert.ok(texts(walk(tree)).join('|').includes('开局'), '表头应显示开局')
  // 回归：讲解点与问题点同一条规则——只标"已经下到"的那几手，开局盘面必须是干净的
  assert.deepEqual(markerCounts(tree), { problems: 0, notes: 0 },
    '开局标记＝' + JSON.stringify(markerCounts(tree)))
  click('▶')
  assert.equal(stoneCounts(tree).black, 1)
  assert.deepEqual(markerCounts(tree), { problems: 0, notes: 0 },
    '第 1 手标记＝' + JSON.stringify(markerCounts(tree)))
  click('▶')
  click('▶')
  assert.deepEqual(markerCounts(tree), { problems: 1, notes: 1 },
    '第 3 手标记＝' + JSON.stringify(markerCounts(tree))
    + ' 表头＝' + JSON.stringify(texts(walk(tree)).join('|').slice(0, 160)))
  click('⏭')
  const end = stoneCounts(tree)
  assert.equal(end.black, 4, '末手前黑 4 子')
  assert.equal(end.white, 0, '末手提掉白子')
  assert.deepEqual(markerCounts(tree), { problems: 1, notes: 2 },
    '末手标记＝' + JSON.stringify(markerCounts(tree)))

  // 面板与整页共用同一份手数：整页翻手后共享状态跟着走（面板的状态行会同步）
  assert.equal(loaded.plugin.__internals.senseiStore.upto, 5, '翻手同步到共享状态')
})

test('client: 整页图例开关能分别关掉问题手点与讲解点', () => {
  const loaded = loadClient()
  const { senseiPatch } = loaded.plugin.__internals
  const page = boardPageOf(loaded)
  const candidates = [{
    moveNumber: 3, color: 'B', coord: 'ed', coordLabel: 'E16',
    label: '失误', labelKey: 'mistake', winrateLoss: 12, scoreLoss: 4, pv: [],
  }]
  senseiPatch({
    data: {
      path: 'game.sgf', mode: 'analysis', level: '18K', moveCount: 5, variations: 0,
      candidates, board: CAPTURE_BOARD, comments: { 2: '第 2 手的讲解' },
    },
    upto: 3,
  })
  const render = () => { loaded.react.reset(); return page({}) }
  let tree = render()

  // 落在第 3 手（最严重的问题手）：问题点 1 + 讲解点 1（第 2 手）
  assert.deepEqual(markerCounts(tree), { problems: 1, notes: 1 }, '默认两个标注都开着')

  /** 图例里的开关（dgs-keyitem 按钮，按标签找；文字在 span 里，要递归取）。 */
  const chip = (label) => {
    const node = walk(tree).find((n) => n.type === 'button'
      && String(n.props.className || '').includes('dgs-keyitem')
      && texts(walk(n)).join('|').includes(label))
    assert.ok(node, `图例里应有「${label}」这一项`)
    return node
  }
  assert.ok(chip('问题手（紫＞红＞橙）'), '问题手开关')
  assert.ok(chip('有讲解'), '讲解点开关')
  assert.ok(chip('AI 首选 / 变化图'), 'AI 推荐开关')

  chip('问题手（紫＞红＞橙）').props.onClick()
  tree = render()
  assert.deepEqual(markerCounts(tree), { problems: 0, notes: 1 }, '关掉问题手点后只剩讲解点')

  chip('有讲解').props.onClick()
  tree = render()
  assert.deepEqual(markerCounts(tree), { problems: 0, notes: 0 }, '两个都关掉后盘面干净')

  // 再点回来：关掉的项要能重新打开
  chip('问题手（紫＞红＞橙）').props.onClick()
  chip('有讲解').props.onClick()
  tree = render()
  assert.deepEqual(markerCounts(tree), { problems: 1, notes: 1 }, '再点一次应重新显示')

  // 收尾：清掉共享状态，免得影响后续用例
  senseiPatch({ data: null, upto: 0 })
})

// ---------------------------------------------------------------------------
// 右侧栏：.sgf 的原生文档预览（棋盘开在右边，对话留在左边）
// ---------------------------------------------------------------------------

test('client: dsh-resource 文件地址解析（Windows 盘符 / 转义 / 非会话地址）', () => {
  const { plugin } = loadClient()
  const { filePathOfAddress } = plugin.__internals
  assert.equal(typeof filePathOfAddress, 'function', '__internals 应暴露地址解析')
  assert.equal(
    filePathOfAddress('dsh-resource://file/session/sess-1/C:/dsh/WeiQi/a.sgf'),
    'C:/dsh/WeiQi/a.sgf',
  )
  // 路径段逐段解码：带中文与空格的文件名要还原
  assert.equal(
    filePathOfAddress('dsh-resource://file/session/s1/C:/%E6%A3%8B%E8%B0%B1/my%20game.sgf'),
    'C:/棋谱/my game.sgf',
  )
  assert.equal(filePathOfAddress('dsh-resource://file/session/s1/a.sgf?line=3'), 'a.sgf', '查询串应忽略')
  assert.equal(filePathOfAddress('dsh-resource://file/workspace/w1/a.sgf'), '', '非会话作用域不认')
  assert.equal(filePathOfAddress('https://example.com/a.sgf'), '')
  assert.equal(filePathOfAddress(undefined), '')
})

test('client: 为 .sgf 注册右侧栏文档预览（外部档，排在内置兜底之前）', () => {
  const { documents, docInjected, registered } = loadClient({ withDocuments: true })
  assert.equal(documents.length, 1, '应注册一个文档预览实现')
  const definition = documents[0]
  assert.deepEqual(definition.extensions, ['sgf'])
  assert.notEqual(definition.priority, 'builtin', '第三方插件属外部档（priority !== builtin 才排在内置兜底前）')
  assert.equal(typeof definition.title, 'function')
  assert.equal(definition.loading, 'text-pages')
  assert.equal(definition.wrap, false)
  // 正文注册进右侧栏的 document 标签页，key 必须与定义的 id 一致（外壳据此配对）
  assert.deepEqual(docInjected, ['sidebar.right.tab.document'])
  const bodyReg = registered.filter((r) => r.options.name === 'sidebar.right.tab.document')
  assert.equal(bodyReg.length, 1)
  assert.equal(bodyReg[0].options.key, definition.id)
  assert.equal(typeof bodyReg[0].component, 'function')
})

test('client: 宿主没有 documentPreviews 服务时静默跳过（不影响其余注册）', () => {
  const { documents, docInjected, injected } = loadClient()
  assert.equal(documents.length, 0)
  assert.equal(docInjected.length, 0)
  // 面板与左侧栏那三处照常
  assert.deepEqual(injected, ['conversation.composer.dock', 'sidebar.panellist', 'main'])
})

test('client: 右侧栏预览等服务出现再注册（apply 早于官方预览包时不能静默丢）', () => {
  // 真机踩过：插件 apply 早于提供 documentPreviews 的官方包 → ctx.get 拿到
  // undefined 就 return，产物里有代码、右侧栏却仍是纯文本预览。
  const withInject = loadClient({ withInject: true })
  assert.deepEqual(withInject.injectDeps, [['documentPreviews']], '应通过 ctx.inject 等待服务')
  assert.equal(withInject.documents.length, 0, '服务还没出现时不应注册')
  withInject.runInject()
  assert.equal(withInject.documents.length, 1, '服务出现后应完成注册')
  assert.deepEqual(withInject.docInjected, ['sidebar.right.tab.document'])
  // 老路（无 inject 的极简上下文）仍然工作
  const direct = loadClient({ withDocuments: true })
  assert.equal(direct.documents.length, 1)
})

test('路由: session 参数按会话反查工作区根（重启后右侧栏相对路径也能读）', async () => {
  const fixturesDir = join(here, 'fixtures')
  const sessions = { 'sess-1': { header: { id: 'sess-1', cwd: fixturesDir } } }
  const ctx = makeRouteCtx({ sessions })
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')

  // 没有 go_* 调用、没有已知根：相对路径解析不了（正是重启后的空窗）
  const cold = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf'))
  assert.equal(cold.status, 404, '冷启动时单纯相对路径应 404')

  // 带上会话 id：宿主问 sessions 服务拿到工作区根，命中
  const warm = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf')
    + '&session=sess-1')
  assert.equal(warm.status, 200, JSON.stringify(warm.body))
  assert.equal(warm.body.data.moveCount, 106)

  // 查不到的会话 id 不应炸，退回既有候选顺序
  const unknown = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf')
    + '&session=nope')
  assert.equal(unknown.status, 404)
})

test('路由: 没有 sessions 服务时 session 参数被忽略（不抛错）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf')
    + '&session=sess-1')
  assert.equal(r.status, 404)
})

test('client: 右侧栏正文渲染棋盘与问题手（拿 resourceAddress 当棋谱路径）', async () => {
  const { registered, react, docInjected } = loadClient({ withDocuments: true, withEffects: true, withClipboard: true })
  assert.deepEqual(docInjected, ['sidebar.right.tab.document'])
  const bodyReg = registered.filter((r) => r.options.name === 'sidebar.right.tab.document')
  assert.equal(bodyReg.length, 1)
  const Body = bodyReg[0].component

  const gamePath = fixture('real-analysis.sgf')
  const candidates = [{
    moveNumber: 3, color: 'B', coord: 'dd', coordLabel: 'D16', label: '大恶手', labelKey: 'blunder',
    winrateLoss: 25, scoreLoss: 12, pv: [{ label: 'Q16', winratePct: 50 }],
  }]
  const board = {
    size: 19,
    moves: [
      { c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 },
      { c: 'W', x: 15, y: 3 }, { c: 'B', x: 3, y: 15 }, { c: 'W', x: 9, y: 9 },
    ],
    setup: { black: [], white: [] },
  }
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return {
      ok: true,
      json: async () => (String(url).includes('/go-sensei/focus')
        ? { ok: true, focus: null }
        : { ok: true, data: { path: gamePath, mode: 'analysis', level: '18K', moveCount: 6, variations: 0, candidates, board } }),
    }
  }

  const address = 'dsh-resource://file/session/s1/' + gamePath.replace(/\\/g, '/')
  react.reset()
  Body({ resourceAddress: address })
  // 正文在 effect 里加载；桩不自动跑 effect。第 0 个是 store 订阅（useSenseiStore），
  // 第 1 个才是加载，第 2 个是跟随轮询。
  react.runEffect(1)
  await new Promise((r) => setTimeout(r, 30))
  react.reset()
  const tree = Body({ resourceAddress: address })

  const wanted = encodeURIComponent(gamePath.replace(/\\/g, '/'))
  assert.ok(seen.some((u) => u.includes('/go-sensei/review') && u.includes(wanted)),
    `应带着文件路径请求复盘：${seen.join(' , ')}`)
  assert.ok(seen.some((u) => u.includes('session=s1')),
    `应带上会话 id（宿主靠它反查工作区根）：${seen.join(' , ')}`)
  const nodes = walk(tree)
  const svg = nodes.find((n) => n.type === 'svg')
  assert.ok(svg, '右侧栏正文应渲染棋盘')
  assert.equal(svg.props['data-dgs-board'], '19')
  const text = texts(nodes).join('|')
  assert.ok(text.includes('Sensei 棋盘'), text)
  assert.ok(text.includes('第 3/6 手'), '应停在最严重的问题手：' + text)
  assert.ok(text.includes('AI 首选 Q16'), text)
  assert.ok(nodes.some((n) => n.type === 'circle' && n.props.stroke === '#9b1996'), '大恶手紫圈')
  assert.ok(nodes.some((n) => n.type === 'circle' && n.props.stroke === '#0000ff'), 'AI 首选蓝圈')
  const items = nodes.filter((n) => n.type === 'button' && n.props.className === 'dgs-item')
  assert.equal(items.length, 1)
})

// ---------------------------------------------------------------------------
// 已写回的讲解：宿主带上注释、面板显示当前手的讲解
// ---------------------------------------------------------------------------

test('路由: 面板数据带上已写回的讲解注释（按手数）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')

  const { readFileSync: read, writeFileSync: write, mkdirSync } = await import('node:fs')
  const dir = join(here, 'tmp-comments')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'with-comment.sgf')
  const injected = injectComments(read(fixture('real-analysis.sgf'), 'utf8'), [
    { moveNumber: 21, comment: '这手太急：该先补断点。' },
  ])
  write(file, injected.text)

  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(file))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(typeof r.body.data.comments, 'object')
  assert.ok(String(r.body.data.comments['21'] ?? '').includes('这手太急'),
    `应按手数带上注释：${JSON.stringify(r.body.data.comments ?? {}).slice(0, 200)}`)
})

// 用户实报：「对于讲解点也需要标注 AI 首选和变化图」。
// 讲解点未必是问题手（老师也会在好手、关键处写讲解），问题手列表里根本没有它 ——
// 所以宿主另给一份逐手候选（payload.ai），面板靠它在任何一手都能画出首选与变化图。
test('路由: 面板带上逐手 AI 候选（讲解点也有首选/变化图）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')

  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(fixture('real-analysis.sgf')))
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200))
  const ai = r.body.data.ai
  assert.equal(typeof ai, 'object', 'payload 应带 ai 逐手候选')
  // 与列表同口径：第 21 手（黑 F14 大恶手）的首选正是 F16、99.9%（落子者视角），
  // 且带上它的变化线 —— 盘上要画的是**首选之后的后续几手**，所以 line 必须跟着走
  assert.deepEqual(ai['21'][0], { label: 'F16', winratePct: 99.9, line: 'F16 N17 Q5 R14 R15' })
  assert.equal(ai['21'][0].line.split(' ')[0], ai['21'][0].label,
    'line 的第一项是该候选自己，后续才是变化图（面板据此 slice(1)）')
  assert.equal(ai['1'], undefined, '第 1 手没有上一手节点，不该有候选')
  assert.ok(ai['2'], '第 2 手应能看到第 1 手节点给的候选')
  assert.ok(Object.keys(ai).length > r.body.data.candidates.length,
    `有候选的手应多于问题手列表：${Object.keys(ai).length} vs ${r.body.data.candidates.length}`)
  // 只带标签、胜率与变化线：整块分析数据不推给浏览器
  for (const list of Object.values(ai)) {
    assert.ok(list.length <= 3, '每手最多 3 个候选')
    for (const p of list) assert.deepEqual(Object.keys(p).sort(), ['label', 'line', 'winratePct'])
  }
  // 问题手列表里的候选同样要带变化线（盘上画的是它）
  const c21 = r.body.data.candidates.find((c) => c.moveNumber === 21)
  assert.ok(c21, '第 21 手应在问题手列表里')
  assert.equal(c21.pv[0].line, 'F16 N17 Q5 R14 R15', '列表候选也要带变化线')
})

test('client: 讲解点（不是问题手）也标出 AI 首选与变化图', () => {
  const loaded = loadClient()
  const { senseiPatch } = loaded.plugin.__internals
  const page = boardPageOf(loaded)
  const board = {
    size: 19,
    moves: [{ c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 }],
    setup: { black: [], white: [] },
  }
  senseiPatch({
    data: {
      path: 'game.sgf', mode: 'analysis', level: '18K', moveCount: 3, variations: 0,
      // 关键：这一手**不在**问题手列表里，只在 ai 里 —— 以前盘上是空白的。
      // line = 变化线，第一项是首选自己，后续几手才是盘上要画的蓝点。
      candidates: [],
      board,
      comments: { 3: '这手是全局要点，先占住这里。' },
      ai: { 3: [
        { label: 'Q16', winratePct: 56.3, line: 'Q16 D4 R6 C10' },
        // 第 2、3 个候选只该出现在列表说明里，绝不上盘（用户 2026-09-13 明确）
        { label: 'R14', winratePct: 45.1, line: 'R14 D4' },
        { label: 'C6', winratePct: 44.9, line: 'C6 D4' },
      ] },
    },
    upto: 3,
  })
  loaded.react.reset()
  let tree = page({})

  const nodes = walk(tree)
  const boardSvg = nodes.find((n) => n.type === 'svg' && String(n.props.className || '').includes('dgs-board'))
  assert.ok(boardSvg, '应画出棋盘')
  const inBoard = walk(boardSvg)
  const best = inBoard.find((n) => n.props.key === 'best')
  assert.ok(best && best.props.fill === 'rgba(0, 255, 255, 0.5)', '讲解点也要画出 AI 首选青圆')
  assert.equal(best.props.cx, 8 + 15 * (84 / 18))
  assert.equal(best.props.cy, 8 + 3 * (84 / 18))
  assert.ok(inBoard.some((n) => n.props.key === 'bestring' && n.props.stroke === '#0000ff'), '首选点带蓝圈')
  const hint = inBoard.find((n) => n.type === 'rect' && n.props.fill === '#ffc800')
  assert.ok(hint, '首选点旁应有橙底信息条')

  // 变化图 ＝ **首选之后的后续几手**（变化线 D4 → R6 → C10），不是第 2、3 个候选点；
  // 每手都是一颗 ghost stone（半透明棋子 + 变化序号）
  const step = 84 / 18
  const ghosts = ghostStones(tree)
  assert.equal(ghosts.length, 3, `盘上应只有变化线的 3 手（实际 ${ghosts.map((n) => n.key).join(',')}）`)
  assert.deepEqual(ghosts.map((n) => n.cx), [8 + 3 * step, 8 + 16 * step, 8 + 2 * step], 'D4 → R6 → C10')
  assert.deepEqual(ghosts.map((n) => n.cy), [8 + 15 * step, 8 + 13 * step, 8 + 9 * step])
  assert.deepEqual(ghosts.map((n) => n.number), ['2', '3', '4'],
    '序号从 2 起：变化里的第 2、3、4 手（第 1 手＝首选，另有青圆蓝圈）')
  // 第 3 手是黑 D16 → 变化第 2 手白、第 3 手黑、第 4 手白
  assert.deepEqual(ghosts.map((n) => n.black), [false, true, false], '按轮转分黑白')
  assert.deepEqual(ghosts.map((n) => n.numberFill), ['#111111', '#ffffff', '#111111'], '数字反色')
  // 候选点不上盘：第 2 个候选 R14 在 (16,5)、第 3 个 C6 在 (2,13)，盘上都不该有点
  assert.ok(!inBoard.some((n) => n.props.cx === 8 + 16 * step && n.props.cy === 8 + 5 * step),
    '第 2 个候选点不该画到盘上')
  assert.ok(!inBoard.some((n) => n.props.cx === 8 + 2 * step && n.props.cy === 8 + 13 * step),
    '第 3 个候选点不该画到盘上')

  const all = texts(nodes).join('|')
  assert.ok(all.includes('Q16'), `信息条与盘下都要念出首选点：${all.slice(0, 200)}`)
  assert.ok(all.includes('AI 首选 Q16（胜率 56.3%）'), all.slice(0, 300))
  assert.ok(all.includes('后续：D4 → R6 → C10'), `盘下要念出变化线：${all.slice(0, 400)}`)
  assert.ok(all.includes('这手是全局要点'), '讲解点应显示写回棋谱的讲解内容')
  // 讲解小方点与 AI 标注并存（两类记号互不吞掉对方）
  assert.equal(inBoard.filter((n) => n.type === 'rect' && n.props.fill === '#7c8cff').length, 1)

  // 画序：AI 首选圆盘要画在讲解小方点**之前**（在下面）。
  // 每一手都会画首选点，而它常常正落在刚下的那一手上；画在后面会给小方点
  // 压一层半透明青色 —— 用户最关心的"这手有讲解"反而糊了。
  const bestIdx = inBoard.findIndex((n) => n.type === 'circle' && n.props.fill === 'rgba(0, 255, 255, 0.5)')
  const noteIdx = inBoard.findIndex((n) => n.type === 'rect' && n.props.fill === '#7c8cff')
  const lastIdx = inBoard.findIndex((n) => n.type === 'circle' && n.props.fill === '#f3f4f6')
  assert.ok(bestIdx >= 0 && noteIdx >= 0 && lastIdx >= 0, '三类记号都应在盘上')
  assert.ok(bestIdx < noteIdx && bestIdx < lastIdx, 'AI 圆盘应画在小记号之下')

  // 图例开关照旧管住这一层：关掉后盘上与文字一起消失（不留下"漏画了"的错觉）
  const chip = walk(tree).find((n) => n.type === 'button'
    && String(n.props.className || '').includes('dgs-keyitem')
    && texts(walk(n)).join('|').includes('AI 首选 / 变化图'))
  assert.ok(chip, '图例里应有 AI 首选 / 变化图 开关')
  chip.props.onClick()
  loaded.react.reset()
  tree = page({})
  const after = walk(tree).find((n) => n.type === 'svg' && String(n.props.className || '').includes('dgs-board'))
  const afterNodes = walk(after)
  assert.ok(!afterNodes.some((n) => n.type === 'circle' && n.props.fill === 'rgba(0, 255, 255, 0.5)'),
    '关掉这一层后不再画首选点')
  assert.ok(!texts(walk(tree)).join('|').includes('AI 首选 Q16'), '说明文字也一起消失')
  assert.equal(afterNodes.filter((n) => n.type === 'rect' && n.props.fill === '#7c8cff').length, 1,
    '讲解小方点不受影响')

  // 收尾：清掉共享状态，免得影响后续用例
  senseiPatch({ data: null, upto: 0 })
})

test('client: 整页显示当前手的讲解注释，面板列表标出「有讲解」', async () => {
  const loaded = loadClient()
  const { senseiPatch } = loaded.plugin.__internals
  const page = boardPageOf(loaded)
  const candidates = [{
    moveNumber: 3, color: 'B', coord: 'dd', coordLabel: 'D16', label: '大恶手', labelKey: 'blunder',
    winrateLoss: 25, scoreLoss: 12, pv: [{ label: 'Q16', winratePct: 50 }],
  }]
  const board = {
    size: 19,
    moves: [
      { c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 },
      { c: 'W', x: 15, y: 3 }, { c: 'B', x: 3, y: 15 }, { c: 'W', x: 9, y: 9 },
    ],
    setup: { black: [], white: [] },
  }
  const data = {
    path: 'game.sgf', mode: 'analysis', level: '18K', moveCount: 6, variations: 0,
    candidates, board, comments: { 3: '这手太急：该先补断点，别急着抢大场。' },
  }

  // ① 整页：当前手有讲解时给出注释框
  senseiPatch({ data, upto: 3 })
  loaded.react.reset()
  let tree = page({})
  const nodes = walk(tree)
  const box = nodes.find((n) => String(n.props.className || '').includes('dgs-comment'))
  assert.ok(box, '当前手有讲解时应显示注释框')
  const text = texts(walk(box)).join('|')
  assert.ok(text.includes('这手太急'), text)
  assert.ok(text.includes('讲解（已写回棋谱注释）'), text)
  assert.ok(texts(nodes).join('|').includes('第 3/6 手'), texts(nodes).join('|'))
  senseiPatch({ data: null, upto: 0 })

  // ② 下方面板：列表里标出哪几手有讲解（棋盘与注释框都不在这里）
  const gamePath = fixture('real-analysis.sgf')
  const props = { inputActions: { setDraft() {} } }
  const { registered, react } = loaded
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, data }),
  })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  react.reset()
  tree = registered[0].component(props)
  const all = texts(walk(tree)).join('|')
  assert.ok(all.includes('有讲解'), `问题手列表里应标出哪几手有讲解：${all}`)
  assert.ok(all.includes('第 3/6 手'), all)
})

test('client: 右侧栏：控件与棋盘同容器（不偏移）、点交叉点复制追问语', async () => {
  const { registered, react, clipboardWrites } = loadClient({ withDocuments: true, withEffects: true, withClipboard: true })
  const gamePath = fixture('real-analysis.sgf')
  const board = {
    size: 19,
    moves: [
      { c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 },
      { c: 'W', x: 15, y: 3 }, { c: 'B', x: 3, y: 15 }, { c: 'W', x: 9, y: 9 },
    ],
    setup: { black: [], white: [] },
  }
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/go-sensei/focus')
      ? { ok: true, focus: null }
      : {
          ok: true,
          data: {
            path: gamePath, mode: 'analysis', level: '18K', moveCount: 6, variations: 0,
            candidates: [], board, comments: {},
            // 三处视图都要有曲线（用户 2026-09-14）：右侧栏比面板宽，看得更清楚
            curve: { winrate: [50, 48, 45, 40, 38, 35], score: [1, 0, -2, -4, -5, -6] },
          },
        }),
  })

  const bodyReg = registered.filter((r) => r.options.name === 'sidebar.right.tab.document')
  const Body = bodyReg[0].component
  const address = 'dsh-resource://file/session/s1/' + gamePath.replace(/\\/g, '/')
  react.reset()
  Body({ resourceAddress: address })
  // 第 0 个 effect 是 store 订阅，加载在第 1 个
  react.runEffect(1)
  await new Promise((r) => setTimeout(r, 30))
  react.reset()
  const tree = Body({ resourceAddress: address })

  // ① 棋盘与控件必须同宽同中：右侧栏比面板宽，"各自居中"会让控件看起来偏了
  const inner = walk(tree).find((n) => String(n.props.className || '').includes('dgs-doc-inner'))
  assert.ok(inner, '棋盘与控件应包在同一个居中容器里')
  const innerTypes = walk(inner).map((n) => n.type)
  assert.ok(innerTypes.includes('svg'), '容器里应有棋盘')
  assert.ok(innerTypes.includes('div') && texts(walk(inner)).join('|').includes('⏮'), '容器里应有控件条')
  // 曲线也在同一个居中容器里（三处视图都要有）
  assert.deepEqual(
    walk(inner).filter((n) => n.type === 'svg' && n.props['data-dgs-curve'] !== undefined)
      .map((n) => n.props['data-dgs-curve']),
    ['winrate', 'score'],
    '右侧栏也要有两条曲线',
  )
  const svg = walk(tree).find((n) => n.type === 'svg' && n.props['data-dgs-board'] !== undefined)

  // ② 点棋盘交叉点 → 复制该点的追问语（右侧栏没有输入框）
  const hit = walk(svg).find((child) => child.props && child.props.fill === 'transparent')
  assert.ok(hit, '棋盘应有透明点击层')
  assert.equal(typeof hit.props.onClick, 'function', '右侧栏棋盘必须接上点击回调')
  hit.props.onClick({
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
    clientX: 8, clientY: 8,
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(clipboardWrites.length, 1, '点击后应写入剪贴板')
  assert.ok(clipboardWrites[0].includes('如果下在 A19'), clipboardWrites[0])
  assert.ok(clipboardWrites[0].includes(gamePath), clipboardWrites[0])
})
