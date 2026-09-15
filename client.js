// client.js — DeepGo Sensei 浏览器 half（Client bundle）
//
// 装载协议：window.__ModuleLoader__.load({ id, factory })，id 必须与
// package.json 的 name 完全一致。工厂收一个 require（宿主平台模块表），
// 可 require('react') —— React 来自宿主共享的表，手写 CJS 外壳、零构建。
//
// 职责（Phase 4）：
//   1. 在 composer dock 注册「Sensei 复盘」入口：展开后输入 SGF 路径 →
//      从 Host 路由 /go-sensei/review 取问题手列表（手数/颜色/坐标/徽标/
//      胜率差/目差/AI 首选）并渲染；
//   2. 点任意一行 → 用插槽 props 的 inputActions.setDraft() 把追问语
//      **真正插入输入框**（不是剪贴板）。
//
// 为什么数据要问 Host：Client 拿不到工具的 execute，也不能直接读盘；Host 的
// index.mjs 拥有 ctx.fs 与 reviewGame，所以由它读盘算好、回 JSON。
//
// 为什么注册在 composer dock 而不是 shell.overlay：只有 composer 系列插槽的
// 标准 props 提供 inputActions（shell.overlay 只有 useSessions/usePanelInfo 等），
// 而「点击插入输入框」必须用它。
//
// 兜底：React 或 slots 缺席时不抛错、静默只装顶部打点，不影响插件其余部分。

window.__ModuleLoader__.load({
  id: 'dsh-go-sensei',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    var React = null
    try {
      // 宿主平台模块表注入的 require；极旧宿主或不传 require 时降级为「无面板」
      React = typeof require === 'function' ? require('react') : null
    } catch (error) {
      React = null
    }

    var STYLE_ID = 'dsh-go-sensei-style'
    var CSS = [
      '[data-dgs] { border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12));',
      '  border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #23242a);',
      '  color: var(--dsw-alias-label-primary, #e8eaf0); font-size: 12px;',
      '  line-height: 1.5; margin: 6px auto 0; max-width: 860px; padding: 8px 10px; }',
      '[data-dgs] .dgs-head { display: flex; align-items: center; gap: 8px; }',
      '[data-dgs] .dgs-title { font-weight: 600; }',
      '[data-dgs] .dgs-sub { color: var(--dsw-alias-label-secondary, #9aa4b2); font-size: 11px; }',
      '[data-dgs] .dgs-spacer { flex: 1; }',
      '[data-dgs] button { cursor: pointer; font: inherit; color: inherit;',
      '  background: var(--dsw-alias-bg-layer-2, #2a2b31);',
      '  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12));',
      '  border-radius: 6px; padding: 3px 8px; }',
      '[data-dgs] button:hover { border-color: var(--dsw-alias-brand-primary, #6b8afd); }',
      '[data-dgs] button[disabled] { opacity: .55; cursor: default; }',
      '[data-dgs] input { flex: 1; min-width: 0; padding: 4px 7px; font: inherit; border-radius: 6px;',
      '  color: var(--dsw-alias-label-primary, #e8eaf0); background: var(--dsw-alias-bg-layer-2, #2a2b31);',
      '  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12)); }',
      '[data-dgs] .dgs-row { display: flex; gap: 6px; margin-top: 6px; }',
      '[data-dgs] .dgs-err { color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 11px; margin-top: 6px; }',
      '[data-dgs] .dgs-ok { color: var(--dsw-alias-state-success-primary, #3fb950); font-size: 11px; margin-top: 6px; }',
      '[data-dgs] .dgs-list { margin-top: 8px; max-height: 300px; overflow-y: auto;',
      '  display: flex; flex-direction: column; gap: 4px; }',
      '[data-dgs] .dgs-item { width: 100%; text-align: left; padding: 5px 8px; }',
      '[data-dgs] .dgs-l1 { display: flex; align-items: center; gap: 8px; }',
      '[data-dgs] .dgs-mv { font-weight: 600; }',
      '[data-dgs] .dgs-coord { color: var(--dsw-alias-label-secondary, #9aa4b2); }',
      '[data-dgs] .dgs-badge { margin-left: auto; font-size: 10px; padding: 0 6px;',
      '  border-radius: 999px; border: 1px solid currentColor; }',
      '[data-dgs] .dgs-l2 { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); }',
      // ── 内置棋盘（可收起）──────────────────────────────────────────────
      '[data-dgs] .dgs-boardwrap { border-top: 1px dashed var(--dsw-alias-border-l1, rgba(255,255,255,.12));',
      '  margin-top: 8px; padding-top: 6px; }',
      '[data-dgs] .dgs-boardhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '[data-dgs] .dgs-boardhead .dgs-sub { flex: 1; min-width: 0; }',
      '[data-dgs] .dgs-board { display: block; width: 100%; height: auto; border-radius: 6px; }',
      '[data-dgs] .dgs-ctl { display: flex; align-items: center; gap: 4px; margin-top: 6px; flex-wrap: wrap; }',
      // 按钮文字不许折行（窄面板里「恶点」会被挤成竖排两行）；挤不下时让滑块换到下一行。
      // 面板宽度随会话栏变化，真机上就撞到过这个问题。
      '[data-dgs] .dgs-ctl button { padding: 2px 6px; white-space: nowrap; flex: 0 0 auto; }',
      '[data-dgs] input[type=range] { flex: 1 1 90px; min-width: 80px; padding: 0; background: transparent; border: none; }',
      '[data-dgs] .dgs-note { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); margin-top: 4px; }',
      // 盘上标注的图例 + 开关：色样 + 名称的小胶囊，点一下开/关
      '[data-dgs] .dgs-key { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }',
      '[data-dgs] .dgs-keyitem { display: inline-flex; align-items: center; gap: 4px; font-size: 10px;',
      '  padding: 1px 7px; border-radius: 999px; white-space: nowrap; }',
      '[data-dgs] .dgs-keyitem svg { flex: 0 0 auto; }',
      '[data-dgs] .dgs-keyoff { opacity: .42; text-decoration: line-through; }',
      // ── 整页棋盘（主区域面板）：棋盘在左、问题手详细说明在右 ──────────────
      '[data-dgs].dgs-page { border: none; border-radius: 0; background: transparent;',
      '  margin: 0; padding: 12px 16px; max-width: none; height: 100%; box-sizing: border-box; }',
      '[data-dgs] .dgs-page-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      // 左＝棋盘（主角，尽量给大：宽度同时受列宽与视口高度约束，别把讲解挤出屏幕）；
      // 右＝曲线 + 问题手列表；图例与讲解单独占底部整幅宽度。
      '[data-dgs] .dgs-page-body { display: flex; gap: 16px; align-items: flex-start; margin-top: 8px; }',
      // 高度算式：视口高 - 棋盘以外的固定开销（页头/控件条/状态行/图例/讲解 118px ≈ 340px），
      // 这样讲解一定留在屏幕里；窗口太矮时保底 300px 棋盘，宁可整体滚动也不把棋盘压成小图。
      '[data-dgs] .dgs-page-board { flex: 0 1 auto; width: min(760px, max(340px, 100vh - 340px)); min-width: 300px; }',
      '[data-dgs] .dgs-page-side { flex: 1 1 420px; min-width: 280px; max-width: 560px; display: flex;',
      '  flex-direction: column; gap: 6px; min-height: 0; }',
      '[data-dgs] .dgs-page-side .dgs-curves { margin-top: 0; }',
      // 列表高度留出底部的讲解：曲线 + 列表合起来别高过棋盘那一列，讲解才不会掉出屏幕
      '[data-dgs] .dgs-page-list { min-width: 0; max-height: min(34vh, 340px); overflow-y: auto;',
      '  display: flex; flex-direction: column; gap: 6px; }',
      // 讲解给一块实打实的高度（够看五六行），太长时它自己滚，不跟棋盘抢空间
      '[data-dgs] .dgs-page-foot { margin-top: 10px; }',
      '[data-dgs] .dgs-foothead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      '[data-dgs] .dgs-foothead .dgs-key { margin-top: 0; }',
      '[data-dgs] .dgs-page-foot .dgs-comment { min-height: 118px; max-height: 240px; }',
      // 主区域被挤窄（左侧栏收窄、分屏）时退回单列：棋盘居中，曲线与列表排到它下面。
      // 单列也守着高度算式，免得棋盘占满整屏把讲解顶到很远的地方。
      '@media (max-width: 860px) {',
      '  [data-dgs] .dgs-page-body { flex-wrap: wrap; }',
      '  [data-dgs] .dgs-page-board { width: min(100%, max(340px, 100vh - 340px)); min-width: 0; margin: 0 auto; }',
      '  [data-dgs] .dgs-page-side { flex: 1 1 100%; max-width: none; }',
      '}',
      '[data-dgs] .dgs-page-item { width: 100%; text-align: left; padding: 7px 10px; }',
      '[data-dgs] .dgs-page-empty { margin-top: 16px; max-width: 620px; line-height: 1.8; }',
      '[data-dgs] .dgs-page-empty ul { margin: 6px 0 6px 18px; padding: 0; }',
      '[data-dgs] .dgs-icon { display: block; }',
      '[data-dgs] .dgs-prob { color: var(--dsw-alias-state-error-primary, #e5534b); }',
      '[data-dgs] .dgs-rec { color: var(--dsw-alias-state-success-primary, #3fb950); }',
      // ── 已写回棋谱的讲解（当前手有注释时显示在棋盘下方）──────────────
      '[data-dgs] .dgs-comment { margin-top: 6px; padding: 6px 8px; border-radius: 4px;',
      '  border-left: 3px solid var(--dsw-alias-brand-primary, #6b8afd);',
      '  background: var(--dsw-alias-bg-layer-2, #2a2b31); font-size: 12px; line-height: 1.55;',
      '  max-height: 170px; overflow-y: auto; white-space: pre-wrap; }',
      '[data-dgs] .dgs-comment-tag { font-size: 10px; margin-bottom: 2px;',
      '  color: var(--dsw-alias-label-secondary, #9aa4b2); }',
      '[data-dgs] .dgs-hasnote { color: var(--dsw-alias-brand-primary, #6b8afd); }',
      // ── 胜率 / 目差曲线（三处视图共用，可折叠）──────────────────────────
      '[data-dgs] .dgs-curves { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }',
      '[data-dgs] .dgs-curve { display: flex; flex-direction: column; }',
      '[data-dgs] .dgs-curvehead { display: inline-flex; align-items: center; gap: 8px;',
      '  align-self: flex-start; padding: 2px 8px; white-space: nowrap; }',
      '[data-dgs] .dgs-curvehead .dgs-val { color: var(--dsw-alias-label-secondary, #9aa4b2); }',
      '[data-dgs] .dgs-chart { display: block; width: 100%; max-width: 560px; height: auto; margin-top: 4px;',
      '  border-radius: 6px; background: var(--dsw-alias-bg-layer-2, #2a2b31); }',
      '[data-dgs] .dgs-chart-hit { cursor: pointer; }',
      '[data-dgs] .dgs-chart-hint { font-size: 10px; margin-top: 2px;',
      '  color: var(--dsw-alias-label-secondary, #9aa4b2); }',
      // ── 右侧栏文档预览（.sgf 在原生右侧栏里打开时的棋盘）────────────────
      '[data-dgs].dgs-doc { border: none; background: transparent; margin: 0; padding: 8px 10px;',
      '  max-width: none; border-radius: 0; }',
      '[data-dgs] .dgs-doc-head { display: flex; align-items: center; gap: 8px; }',
      '[data-dgs] .dgs-doc-head .dgs-spacer { flex: 1; }',
      '[data-dgs] .dgs-doc-status { font-size: 12px; margin: 6px 0 2px; }',
      // 右侧栏文档预览＝左列「棋盘 + 控件条」、右列「两条曲线」，与整页同一套分工。
      // 别再拿 100vh 猜侧栏高度（侧栏高度≠窗口高度，实测会把棋盘压到 280px 下限，
      // 曲线还照样压在棋盘下方）。改成 flex 折行：够宽就并排，侧栏拖窄了自动回单列。
      '[data-dgs] .dgs-doc-inner { display: flex; flex-wrap: wrap; justify-content: center;',
      '  align-items: flex-start; gap: 10px 12px; width: 100%; }',
      '[data-dgs] .dgs-doc-main { flex: 2 1 320px; max-width: 480px; min-width: 0; }',
      '[data-dgs] .dgs-doc-board { width: 100%; margin: 0 auto; }',
      '[data-dgs] .dgs-doc-inner .dgs-curves { flex: 1 1 260px; max-width: 380px; min-width: 0; margin-top: 0; }',
      '[data-dgs] .dgs-doc-list { max-height: none; }',
      // 图例 + 手数小结 + 讲解自成一块：右侧栏很窄，讲解至少要有一整行高度，
      // 不能夹在图例和列表之间被压成一条缝（与整页 .dgs-page-foot 同一套做法）
      '[data-dgs] .dgs-doc-foot { margin-top: 8px; }',
      '[data-dgs] .dgs-doc-foot .dgs-comment { min-height: 118px; max-height: 260px; }',
    ].join('\n')

    /**
     * 注入样式（幂等；只插一次，避免重复注册时堆积）。
     *
     * 已存在时**必须比对并覆盖**：客户端插件改动走热重载，模块会重新执行，
     * 但上一次插进 <head> 的 <style> 不会消失 —— 只判「存在就 return」的话，
     * 纯 CSS 改动（不改 DOM 结构的那种）在热重载后永远不生效，表现为
     * 「代码明明改了、界面一点没变」（2026-09-14 实测踩到）。
     */
    function ensureStyles() {
      try {
        var style = document.getElementById(STYLE_ID)
        if (style !== null) {
          if (style.textContent !== CSS) style.textContent = CSS
          return
        }
        style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      } catch (error) {
        // 非浏览器环境（测试桩）忽略
      }
    }

    /** 请求超过这么久还没回来，就说一句「在补算」——实测这类棋谱要等 1~2 分钟。 */
    var SLOW_HINT_DELAY = 5000

    /** 按标签上色：大恶手→error、失误→warn、其余→次要色。 */
    function severityColor(label) {
      var text = String(label == null ? '' : label)
      if (text.indexOf('大恶手') >= 0) return 'var(--dsw-alias-state-error-primary, #e5534b)'
      if (text.indexOf('失误') >= 0) return 'var(--dsw-alias-state-warn-primary, #d29922)'
      return 'var(--dsw-alias-label-secondary, #9aa4b2)'
    }

    // -----------------------------------------------------------------------
    // 内置棋盘：规则 + 渲染
    //
    // 为什么规则要写在客户端：让子、提子、虚着之后，盘面无法由"手顺列表"
    // 直接得出——中间某一步可能整块被提掉。判死活是画对棋盘的最小前提，
    // 所以这里带一份只做"落子/提子"的迷你规则（不含劫争判定：复盘场景下
    // 每一手都是棋谱上真实存在的着手，不会出现需要判劫的非法手）。
    // -----------------------------------------------------------------------

    /** 列标（跳过 I，与 sgf.js coordLabel 一致）。 */
    var BOARD_COLS = 'ABCDEFGHJKLMNOPQRST'
    /** SVG 视口是 100x100 的无量纲坐标，实际尺寸交给 CSS。 */
    var BOARD_VIEW = 100
    /** 边距：给坐标标注留出的空间（视口单位）。 */
    var BOARD_PAD = 8
    /** 棋手名条的视口高度（只有拿到棋手名时才占这一条）。 */
    var BOARD_NAME_H = 6

    // ── 与 Lizzieyzy 对齐的视觉约定 ────────────────────────────────────────
    // 参照其 FloatBoardRenderer.java：drawMoveRankMark（最后一手 = 反色小圆点，
    // 半径 = 0.22 × 格宽）、drawMoveRankMarkCircle:1052（失误按严重度取
    // 紫/红/橙三档色）、drawLeelazSuggestions:1498（AI 首选 = 青色实心圆 +
    // 蓝色外圈，showBlueRing 默认开；其余候选按计算量在红→绿之间取色）、
    // drawStringForOrder:2811（推荐点信息 = 橙底黑字）、drawGoban:2892
    // （网格纯黑、外框线加粗、白子黑色描边）。用户平时看惯了这套配色，
    // 讲解时两边的"哪个点是什么意思"才对得上。
    var LAST_MOVE_R = 0.22
    var BEST_FILL = 'rgba(0, 255, 255, 0.5)' // theme best-move-color [0,255,255,240]
    var BEST_RING = '#0000ff' // Color.BLUE（showBlueRing）
    var BEST_INFO_BG = '#ffc800' // Color.ORANGE
    // 变化图后续几手 = Lizzieyzy 的 ghost stone：一颗按轮转取色的棋子 + 正中序号。
    // 唯有一处与那边不同 —— 棋子取半透明。Lizzie 的盘面只画变化本身，而我们的
    // 棋盘底下还有**真实局面**：画成不透明的子，学生就分不清哪几手是真下的了。
    var GHOST_BLACK = '#141519'
    var GHOST_WHITE = '#f7f8fa'
    var GHOST_ALPHA = 0.55
    var MARK_COLORS = {
      blunder: '#9b1996', // (155,25,150) 最严重一档
      mistake: '#d01013', // (208,16,19)
      inaccuracy: '#c88c32', // (200,140,50)
    }

    /** 问题手标记色：优先按 labelKey，回退按中文标签（老版本 Host 不带 key）。 */
    function markColor(labelKey, labelText) {
      if (labelKey !== undefined && MARK_COLORS[labelKey] !== undefined) return MARK_COLORS[labelKey]
      var text = String(labelText == null ? '' : labelText)
      if (text.indexOf('大恶手') >= 0) return MARK_COLORS.blunder
      if (text.indexOf('失误') >= 0) return MARK_COLORS.mistake
      return MARK_COLORS.inaccuracy
    }

    /** 交叉点 -> 人类标签（如 (15,3) -> 'Q16'）。 */
    function boardLabel(x, y, size) {
      var col = x >= 0 && x < BOARD_COLS.length ? BOARD_COLS.charAt(x) : String(x)
      return col + String(size - y)
    }

    /**
     * 棋手名 -> 名条上的文字：'名字（段位）'；只有段位时写段位，都没有时为空串。
     * 与宿主 half 的 diagram.js playerLabels 同一口径（那边画配图，这边画面板，
     * 两边不能各写各的，否则同一盘棋在两处的写法会不一样）。
     */
    function playerNameText(name, rank) {
      var n = String(name == null ? '' : name).replace(/^\s+|\s+$/g, '')
      var r = String(rank == null ? '' : rank).replace(/^\s+|\s+$/g, '')
      if (n === '') return r
      return r === '' ? n : n + '（' + r + '）'
    }

    /** 太长会把左右两条挤到一起：超过 14 字截断加省略号。 */
    function clipPlayerName(text) {
      var s = String(text)
      return s.length > 14 ? s.slice(0, 13) + '…' : s
    }

    /**
     * KataGo 风格标签（'R16'）-> {x, y}；解析不了或落在盘外返回 null。
     * 小棋盘（9/13 路）上引擎不会给出路数外的点，但标签来自棋谱/引擎文本，
     * 挡一道越界免得把标记画到盘外。
     */
    function parsePointLabel(label, size) {
      var m = /^([A-Za-z])(\d{1,2})$/.exec(String(label == null ? '' : label))
      if (m === null) return null
      var x = BOARD_COLS.indexOf(m[1].toUpperCase())
      var row = parseInt(m[2], 10)
      if (x < 0 || x >= size || !(row >= 1 && row <= size)) return null
      return { x: x, y: size - row }
    }

    /** 空盘：0 空、1 黑、2 白；下标 = y * size + x。 */
    function emptyGrid(size) {
      var grid = new Array(size * size)
      for (var i = 0; i < grid.length; i++) grid[i] = 0
      return grid
    }

    /**
     * 取 (x,y) 所在棋串的同色点与气数（气点去重）。空点返回 null。
     * @returns {{ stones: number[][], libs: number }|null}
     */
    function groupAt(grid, size, x, y) {
      var color = grid[y * size + x]
      if (color === 0) return null
      var stones = []
      var libs = 0
      var seen = {}
      var stack = [[x, y]]
      seen[y * size + x] = true
      while (stack.length > 0) {
        var p = stack.pop()
        stones.push(p)
        var nb = [[p[0] + 1, p[1]], [p[0] - 1, p[1]], [p[0], p[1] + 1], [p[0], p[1] - 1]]
        for (var i = 0; i < nb.length; i++) {
          var nx = nb[i][0]
          var ny = nb[i][1]
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
          var key = ny * size + nx
          if (seen[key] === true) continue
          seen[key] = true
          var v = grid[key]
          if (v === 0) libs += 1
          else if (v === color) stack.push([nx, ny])
        }
      }
      return { stones: stones, libs: libs }
    }

    /** 落子并提掉无气的对方棋串；返回被提子数。 */
    function playStone(grid, size, x, y, color) {
      grid[y * size + x] = color
      var opp = color === 1 ? 2 : 1
      var captured = 0
      var nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
      for (var i = 0; i < nb.length; i++) {
        var nx = nb[i][0]
        var ny = nb[i][1]
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        if (grid[ny * size + nx] !== opp) continue
        var g = groupAt(grid, size, nx, ny)
        if (g !== null && g.libs === 0) {
          for (var j = 0; j < g.stones.length; j++) {
            grid[g.stones[j][1] * size + g.stones[j][0]] = 0
            captured += 1
          }
        }
      }
      var own = groupAt(grid, size, x, y)
      if (own !== null && own.libs === 0) {
        // 自杀：真实棋谱不会出现，防御性清掉，免得不合规则的谱把棋盘画坏
        for (var k = 0; k < own.stones.length; k++) grid[own.stones[k][1] * size + own.stones[k][0]] = 0
      }
      return captured
    }

    /**
     * 摆出「前 upto 手」的局面（含 AB/AW 摆子）。
     *
     * 结果按「同一个 board 对象 + 同一手数」缓存：面板每敲一个字符都会重渲染，
     * 而重算一次要重放整局棋；用对象标识做键既便宜，也不会把两盘棋搞混。
     * （返回的数组由调用方只读使用，不再复制。）
     *
     * @param {{ size: number, moves: object[], setup?: object }} board 服务端 compactBoard 的产物
     * @param {number} upto 显示到第几手（0 = 开局）
     * @returns {number[]} 盘面网格（0 空 / 1 黑 / 2 白，下标 = y * size + x）
     */
    function boardAt(board, upto) {
      var size = board.size
      var moves = board.moves || []
      var limit = Math.max(0, Math.min(upto, moves.length))
      if (boardCache.board === board && boardCache.upto === limit) return boardCache.grid
      var grid = emptyGrid(size)
      var setup = board.setup || {}
      var black = setup.black || []
      var white = setup.white || []
      var i
      for (i = 0; i < black.length; i++) grid[black[i][1] * size + black[i][0]] = 1
      for (i = 0; i < white.length; i++) grid[white[i][1] * size + white[i][0]] = 2
      for (i = 0; i < limit; i++) {
        var m = moves[i]
        if (m.x < 0 || m.y < 0) continue
        playStone(grid, size, m.x, m.y, m.c === 'B' ? 1 : 2)
      }
      boardCache.board = board
      boardCache.upto = limit
      boardCache.grid = grid
      return grid
    }

    /** 盘面缓存：{ board 对象标识, 手数 } -> 网格。 */
    var boardCache = { board: null, upto: -1, grid: null }

    /** 星位（19/13/9 路常用坐标，其余路数不画）。 */
    function starPoints(size) {
      var base = size === 19 ? [3, 9, 15] : size === 13 ? [3, 6, 9] : size === 9 ? [2, 4, 6] : []
      var out = []
      for (var i = 0; i < base.length; i++) {
        for (var j = 0; j < base.length; j++) out.push([base[i], base[j]])
      }
      return out
    }

    /**
     * 画一张棋盘（SVG）。
     * @param {object} opts
     * @param {object} opts.board 服务端棋盘数据
     * @param {number} opts.upto 显示到第几手
     * @param {object|null} opts.problem 当前手的问题手标记（{x, y, key, label}）或 null
     * @param {Array<object|null>} [opts.pv] 变化图前几手的坐标（第 0 项 = AI 首选）
     * @param {string} [opts.hintLabel] 首选点旁的信息文本（胜率等）
     * @param {{black?:string,white?:string,blackRank?:string,whiteRank?:string}} [opts.players] 棋手
     *        ——名字与段位画在棋盘上沿（用户 2026-09-15：所有棋盘都要有黑方白方的名字）
     * @param {function} [opts.onPick] 点击交叉点回调 (x, y)
     * @returns {object} React 元素
     */
    function renderBoard(opts) {
      var size = opts.board.size
      var moves = opts.board.moves || []
      var grid = boardAt(opts.board, opts.upto)
      var step = (BOARD_VIEW - BOARD_PAD * 2) / Math.max(1, size - 1)
      var pos = function (i) { return BOARD_PAD + i * step }
      var radius = step * 0.46
      var kids = []
      // 名条（黑在左、白在右，各带一颗对应颜色的棋子点）。棋谱没写棋手名时
      // 整条不出现：留一条空木头反而像是画错了。
      var players = opts.players && typeof opts.players === 'object' ? opts.players : {}
      var blackName = clipPlayerName(playerNameText(players.black, players.blackRank))
      var whiteName = clipPlayerName(playerNameText(players.white, players.whiteRank))
      var hasNames = blackName !== '' || whiteName !== ''
      var nameBand = hasNames ? BOARD_NAME_H : 0
      // 视口高度 = 名条 + 棋盘；横向仍是 100，坐标体系不动（盘面内容整体下移一条）。
      var boardViewH = BOARD_VIEW + nameBand
      kids.push(React.createElement('rect', {
        key: 'bg', x: 0, y: 0, width: BOARD_VIEW, height: boardViewH, rx: 1.5, fill: 'url(#dgs-wood)',
      }))
      if (blackName !== '') {
        kids.push(React.createElement('circle', {
          key: 'namdotb', cx: 3.4, cy: 2.9, r: 1.15, fill: 'url(#dgs-black)', pointerEvents: 'none',
        }))
        kids.push(React.createElement('text', {
          key: 'nametb', x: 5.6, y: 4, fontSize: 3.4, fill: '#1b1b1b', pointerEvents: 'none',
        }, '黑 ' + blackName))
      }
      if (whiteName !== '') {
        kids.push(React.createElement('circle', {
          key: 'namdotw', cx: BOARD_VIEW - 3.4, cy: 2.9, r: 1.15, fill: 'url(#dgs-white)',
          stroke: '#111111', strokeWidth: 0.12, pointerEvents: 'none',
        }))
        kids.push(React.createElement('text', {
          key: 'nametw', x: BOARD_VIEW - 5.6, y: 4, fontSize: 3.4, fill: '#1b1b1b',
          textAnchor: 'end', pointerEvents: 'none',
        }, '白 ' + whiteName))
      }
      // 名条画在视口级（不随盘面下移）；从这里往后推的都是盘面内容，
      // 收尾时整体装进一个 translate 组里 —— 见函数末尾的 contentFrom。
      var contentFrom = kids.length
      var i
      // 网格：纯黑 + 外框加粗（Lizzieyzy drawGoban 的 borderStroke/normalStroke 之分）
      for (i = 0; i < size; i++) {
        var edge = i === 0 || i === size - 1
        var lineW = edge ? 0.55 : 0.28
        kids.push(React.createElement('line', {
          key: 'h' + i, x1: pos(0), y1: pos(i), x2: pos(size - 1), y2: pos(i),
          stroke: '#111111', strokeWidth: lineW,
        }))
        kids.push(React.createElement('line', {
          key: 'v' + i, x1: pos(i), y1: pos(0), x2: pos(i), y2: pos(size - 1),
          stroke: '#111111', strokeWidth: lineW,
        }))
      }
      starPoints(size).forEach(function (p, index) {
        kids.push(React.createElement('circle', {
          key: 'star' + index, cx: pos(p[0]), cy: pos(p[1]), r: 0.75, fill: '#111111',
        }))
      })
      // 坐标：列标在上、行号在左（讲解里说"Q16"时，学生能在盘上直接找到）
      for (i = 0; i < size; i++) {
        kids.push(React.createElement('text', {
          key: 'col' + i, x: pos(i), y: BOARD_PAD / 2 + 1.4, fontSize: 2.8, fill: '#111111',
          textAnchor: 'middle',
        }, BOARD_COLS.charAt(i)))
        kids.push(React.createElement('text', {
          key: 'row' + i, x: BOARD_PAD / 2, y: pos(i) + 1.1, fontSize: 2.8, fill: '#111111',
          textAnchor: 'middle',
        }, String(size - i)))
      }

      // 棋子（白子带黑色描边，与 Lizzieyzy drawStoneSimple 一致）
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var v = grid[y * size + x]
          if (v === 0) continue
          var isBlack = v === 1
          kids.push(React.createElement('circle', {
            key: 'st' + x + '_' + y,
            className: isBlack ? 'dgs-stone dgs-stone-b' : 'dgs-stone dgs-stone-w',
            cx: pos(x), cy: pos(y), r: radius,
            fill: isBlack ? 'url(#dgs-black)' : 'url(#dgs-white)',
            stroke: isBlack ? 'none' : '#111111',
            strokeWidth: isBlack ? 0 : Math.max(0.12, radius / 16),
          }))
        }
      }

      // 变化图（PV）：首选一点 = 青色实心圆 + 蓝圈（旁边还有橙底胜率条）；首选
      // **之后**的后续几手按 Lizzieyzy 的 ghost stone 画 —— 半透明棋子（按轮转
      // 分黑白）+ 棋子正中的变化序号（首选＝1，所以后续从 2 起）。
      //
      // 位置有讲究：AI 标注要画在**讲解小方点 / 最后一手圆点 / 问题手色点之前**。
      // 自 2026-09-13 起每一手（含讲解点）都会画首选点，青色半透明圆盘常常正落在
      // 刚下的那一手上 —— 画在后面会把用户最关心的那几个小记号（"这手有讲解"
      // "最后一手"）压上一层青色。记号小而实、变化棋大而淡，让小的在上面才对。
      //
      // 最后一手先算出来：变化的第一手是"第 upto 手改下哪里"，所以由**刚落下的
      // 那一手**同色的人来下（候选本来就是这一手的替代着法），后续逐手轮转 ——
      // 与 Lizzieyzy 的 Branch.java（blackToPlay 交替）同一套口径。
      var lastIndex = Math.max(0, Math.min(opts.upto, moves.length)) - 1
      var last = lastIndex >= 0 ? moves[lastIndex] : null
      var pv = opts.showHint === false || !Array.isArray(opts.pv) ? [] : opts.pv
      pvGhostStones(pv, grid, size, last === null ? null : last.c).forEach(function (s) {
        kids.push(React.createElement('circle', {
          key: 'pv' + (s.number - 1), cx: pos(s.x), cy: pos(s.y), r: radius,
          fill: s.black ? GHOST_BLACK : GHOST_WHITE, fillOpacity: GHOST_ALPHA,
          stroke: s.black ? 'none' : '#111111',
          strokeWidth: s.black ? 0 : Math.max(0.12, radius / 16),
          pointerEvents: 'none',
        }))
        // 数字反色（黑棋上白字、白棋上黑字），Lizzieyzy drawBranch 同款
        kids.push(React.createElement('text', {
          key: 'pvt' + (s.number - 1), x: pos(s.x), y: pos(s.y) + radius * 0.45,
          fontSize: radius * 1.15, fill: s.black ? '#ffffff' : '#111111',
          textAnchor: 'middle', pointerEvents: 'none',
        }, String(s.number)))
      })
      if (pv.length > 0 && pv[0] !== null && pv[0] !== undefined) {
        kids.push(React.createElement('circle', {
          key: 'best', cx: pos(pv[0].x), cy: pos(pv[0].y), r: radius + 0.2, fill: BEST_FILL,
          pointerEvents: 'none',
        }))
        kids.push(React.createElement('circle', {
          key: 'bestring', cx: pos(pv[0].x), cy: pos(pv[0].y), r: radius + 0.6, fill: 'none',
          stroke: BEST_RING, strokeWidth: 0.45, pointerEvents: 'none',
        }))
      }

      // 已写回的讲解：有讲解的手在棋子左上角点一个小方点（与 Lizzieyzy 的
      // 注释节点标记同一语义），学生一眼看出"哪几手有老师的话"。
      // 两条规则：① 可在图例里关掉（showNote=false 时整类不画）；
      // ② 只标**已经走到**的那些手——否则开局（0 手）就把全盘的讲解点亮着，
      //    看着像一堆来历不明的点，也说明不了"讲到哪儿了"。
      var noteMoves = opts.showNote === false || !Array.isArray(opts.noteMoves) ? [] : opts.noteMoves
      for (var nm = 0; nm < noteMoves.length; nm++) {
        if (noteMoves[nm] > opts.upto) continue
        var noted = moves[noteMoves[nm] - 1]
        if (noted === undefined || noted.x < 0) continue
        kids.push(React.createElement('rect', {
          key: 'note' + noteMoves[nm],
          x: pos(noted.x) - radius * 0.98, y: pos(noted.y) - radius * 0.98,
          width: radius * 0.6, height: radius * 0.6, fill: '#7c8cff', pointerEvents: 'none',
        }))
      }

      // 最后一手：反色小实心圆点，半径 0.22 格宽（Lizzieyzy 的最后一手指示）。
      // lastIndex / last 在上面（画变化图之前）已经算好，顺带给变化定先手颜色。
      if (last !== null && last.x >= 0) {
        kids.push(React.createElement('circle', {
          key: 'last', cx: pos(last.x), cy: pos(last.y), r: step * LAST_MOVE_R,
          fill: last.c === 'B' ? '#f3f4f6' : '#141519', pointerEvents: 'none',
        }))
      }

      // 问题手：每处点一个小色点（Lizzieyzy 的着法质量色块同款做法）。
      // 与讲解点同一条规则：可在图例里关掉，且只标**已经下到**的那些手——
      // 停在开局时盘面就该是干净的，问题点随棋局展开一处处长出来。
      var marks = opts.showProblem === false || !Array.isArray(opts.marks) ? [] : opts.marks
      marks.forEach(function (m, index) {
        if (typeof m.n === 'number' && m.n > opts.upto) return
        kids.push(React.createElement('circle', {
          key: 'mark' + index, cx: pos(m.x), cy: pos(m.y), r: step * 0.16,
          fill: m.color, fillOpacity: 0.92, pointerEvents: 'none',
        }))
      })

      // 当前这一手的问题手：大圈强调（颜色＝严重度）
      if (opts.showProblem !== false && opts.problem !== null && opts.problem !== undefined) {
        kids.push(React.createElement('circle', {
          key: 'problem', cx: pos(opts.problem.x), cy: pos(opts.problem.y), r: radius * 1.12,
          fill: 'none', stroke: markColor(opts.problem.key, opts.problem.label),
          strokeWidth: 0.7, pointerEvents: 'none',
        }))
      }

      // 首选点的胜率：橙底黑字（Lizzieyzy drawStringForOrder 的信息条样式）。
      // pv[0] 可能解析失败（候选标签不是坐标，比如 'pass' 或空字符串）——
      // 那时只能不画信息条：渲染期抛错会整块面板一起挂掉。
      if (opts.hintLabel && pv.length > 0 && pv[0] !== null && pv[0] !== undefined) {
        var text = String(opts.hintLabel)
        var boxW = text.length * 1.55 + 1.6
        var boxX = Math.max(0, Math.min(BOARD_VIEW - boxW, pos(pv[0].x) + radius * 0.9))
        var boxY = Math.max(0, pos(pv[0].y) - radius * 2.6)
        kids.push(React.createElement('rect', {
          key: 'hinlabelbg', x: boxX, y: boxY, width: boxW, height: 3.4, fill: BEST_INFO_BG,
          pointerEvents: 'none',
        }))
        kids.push(React.createElement('text', {
          key: 'hinlabel', x: boxX + boxW / 2, y: boxY + 2.5, fontSize: 2.5, fill: '#000000',
          textAnchor: 'middle', pointerEvents: 'none',
        }, text))
      }

      if (typeof opts.onPick === 'function') {
        kids.push(React.createElement('rect', {
          key: 'hit', x: 0, y: 0, width: BOARD_VIEW, height: BOARD_VIEW, fill: 'transparent',
          style: { cursor: 'crosshair' },
          onClick: function (event) {
            try {
              var box = event.currentTarget.getBoundingClientRect()
              var px = (event.clientX - box.left) / (box.width || 1) * BOARD_VIEW
              // 纵向要按**整个视口**（名条 + 棋盘）换算，再减掉名条 ——
              // 否则有名条时点哪一手都会偏上一条的高度。
              var py = (event.clientY - box.top) / (box.height || 1) * boardViewH - nameBand
              var gx = Math.round((px - BOARD_PAD) / step)
              var gy = Math.round((py - BOARD_PAD) / step)
              opts.onPick(Math.max(0, Math.min(size - 1, gx)), Math.max(0, Math.min(size - 1, gy)))
            } catch (error) {
              /* 点击失败绝不能影响面板 */
            }
          },
        }))
      }

      // 名条以下的所有盘面内容整体下移一条：坐标、棋子、标记的算法一个字不改。
      // 点击换算已按整个视口（boardViewH）折算，见上面的 hit 矩形。
      var viewLevel = kids.slice(0, contentFrom)
      var bodyKids = kids.slice(contentFrom)
      kids = viewLevel.concat([
        React.createElement('g', { key: 'board', transform: 'translate(0,' + nameBand + ')' }, bodyKids),
      ])

      kids.unshift(React.createElement('defs', { key: 'defs' },
        React.createElement('linearGradient', { id: 'dgs-wood', x1: '0', y1: '0', x2: '0', y2: '1' },
          React.createElement('stop', { offset: '0%', stopColor: '#e8c383' }),
          React.createElement('stop', { offset: '100%', stopColor: '#d6a75d' })),
        React.createElement('radialGradient', { id: 'dgs-black', cx: '35%', cy: '30%', r: '78%' },
          React.createElement('stop', { offset: '0%', stopColor: '#5c6169' }),
          React.createElement('stop', { offset: '55%', stopColor: '#22242a' }),
          React.createElement('stop', { offset: '100%', stopColor: '#0b0c0f' })),
        React.createElement('radialGradient', { id: 'dgs-white', cx: '35%', cy: '30%', r: '78%' },
          React.createElement('stop', { offset: '0%', stopColor: '#ffffff' }),
          React.createElement('stop', { offset: '62%', stopColor: '#edeff3' }),
          React.createElement('stop', { offset: '100%', stopColor: '#c3c9d2' })),
      ))

      return React.createElement('svg', {
        className: 'dgs-board', viewBox: '0 0 ' + BOARD_VIEW + ' ' + boardViewH,
        xmlns: 'http://www.w3.org/2000/svg', 'data-dgs-board': String(size),
      }, kids)
    }

    /**
     * 点棋盘交叉点的追问语（三处视图共用同一句）。
     * 输入框下方面板把它插进输入框；整页与右侧栏没有输入框，改为复制到剪贴板。
     *
     * 末尾那句「请画一张变化图」是刻意的：用户 2026-09-14 要求追问的回答要配图，
     * 而配图靠模型主动调 go_draw_diagram —— 在**提问的那一刻**把要求写进问题里，
     * 比只写在人设里可靠得多（人设会被长对话稀释）。
     */
    function askPointText(data, upto, x, y) {
      if (!data || !data.board) return ''
      var label = boardLabel(x, y, data.board.size)
      return '追问：第 ' + upto + ' 手之后的局面，如果下在 ' + label
        + ' 会怎样？请讲讲这一手的价值与后续变化，并画一张变化图（1、2、3…标出顺序）。'
        + (data.path ? '（棋谱：' + data.path + '）' : '')
    }

    /** 复制到剪贴板（三处视图共用）：没有剪贴板权限时如实说明，不假装成功。 */
    function copyText(text, onDone, onFail) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(onDone, onFail)
          return
        }
      } catch (error) {
        /* 无剪贴板权限 → 走 onFail */
      }
      onFail()
    }

    /** 取路径的末段（跨 Windows/Unix 两种分隔符）。 */
    function baseName(path) {
      return String(path == null ? '' : path).replace(/\\/g, '/').split('/').pop()
    }

    /** 某一手的讲解注释（宿主在 payload 的 comments 里按手数给出）。 */
    function commentOf(data, moveNumber) {
      if (!data || !data.comments) return ''
      var text = data.comments[String(moveNumber)]
      return typeof text === 'string' ? text : ''
    }

    /** 有讲解的手数（升序）：用来做「◀讲解 / 讲解▶」跳转与盘上标记。 */
    function commentedMoves(data) {
      var out = []
      if (!data || !data.comments) return out
      for (var key in data.comments) {
        if (!Object.prototype.hasOwnProperty.call(data.comments, key)) continue
        var n = parseInt(key, 10)
        if (Number.isFinite(n) && n > 0 && typeof data.comments[key] === 'string' && data.comments[key] !== '') {
          out.push(n)
        }
      }
      out.sort(function (a, b) { return a - b })
      return out
    }

    /**
     * 当前这一手的 AI 候选（首选 + 变化图）。
     *
     * 两条来源，顺序不能反：
     *   ① 问题手列表里那一行的候选（同一个口径，列表与盘上必然一致）；
     *   ② 宿主按手数给的**逐手**候选（payload.ai）—— 让讲解点（未必是问题手，
     *      老师也会在好手、关键处写讲解）在盘上同样能看到首选点与变化图。
     *
     * @returns {Array<{label: string, winratePct: number|null}>} 无数据时为空数组
     */
    function aiCandidatesAt(data, problem, moveNumber) {
      if (problem !== null && problem !== undefined
        && Array.isArray(problem.pv) && problem.pv.length > 0) {
        return problem.pv
      }
      var map = data && data.ai ? data.ai : null
      var list = map === null ? null : map[String(moveNumber)]
      return Array.isArray(list) ? list : []
    }

    /** 「◌ AI 首选 X（胜率 Y%）」——三处视图共用同一句。 */
    function aiHintText(list) {
      var best = Array.isArray(list) && list.length > 0 ? list[0] : null
      if (best === null || best === undefined || !best.label) return ''
      return '◌ AI 首选 ' + String(best.label)
        + (best.winratePct == null ? '' : '（胜率 ' + String(best.winratePct) + '%）')
    }

    /** 首选之后最多画几手变化图（数据侧由 pvDepth 截断，这里再兜一道）。 */
    var MAX_PV_MOVES = 5

    /**
     * 盘上要画的 AI 线：`[首选点, 变化第 2 手, 第 3 手…]`。
     *
     * 画的是**首选之后的后续几手**（用户 2026-09-13 明确：「不需要候选点，需要首选
     * 之后的后续几手」），不是第 2、3 个候选点。数据来自候选的 `line`
     * （形如 'F16 N17 Q5 R14'，**第一个就是该候选自己**，所以从第二个开始取）。
     *
     * 首选点解析不出来时整条线都不画：那时第一个点会被当成首选画成青圆，等于撒谎。
     *
     * @param {Array<object>} aiList AI 候选（第 0 项＝首选）
     * @param {number} size 棋盘路数
     * @returns {Array<{x: number, y: number}>} 空数组表示没有可画的点
     */
    function aiLinePoints(aiList, size) {
      var best = Array.isArray(aiList) && aiList.length > 0 ? aiList[0] : null
      if (best === null || best === undefined) return []
      var head = parsePointLabel(best.label, size)
      if (head === null) return []
      var out = [head]
      var tokens = String(best.line == null ? '' : best.line).split(/\s+/)
      for (var i = 1; i < tokens.length && out.length <= MAX_PV_MOVES; i++) {
        if (tokens[i] === '') continue
        var pt = parsePointLabel(tokens[i], size)
        if (pt !== null) out.push(pt)
      }
      return out
    }

    /**
     * 变化图后续几手 → 盘上的「幽灵棋」：每手的坐标、黑白与变化序号。
     *
     * 画法照抄 Lizzieyzy 的 drawBranch（BoardRenderer.java:1420 起 / Branch.java）：
     * 后续每一手都画成**一颗棋子**、按轮转分黑白，棋子正中写它在这条变化里的序号
     * —— 首选＝1（面板上另有青圆蓝圈标记），所以后续从 2 起，数字反色（黑棋上白字、
     * 白棋上黑字）。原先的小蓝点看不出"这一手是谁下的"，学生读到"黑棋挡、白棋扳"
     * 时对不上盘面。
     *
     * 两处刻意的取舍：
     *   ① 落点已被实战棋子占住的整颗不画 —— 画上去像把子叠在子上（Lizzieyzy 在
     *      removeDeadChainInVariation=false 时同样跳过实战有子的点）；序号不重排，
     *      跳过就是跳过，与那边逐点取数的效果一致。
     *   ② 颜色只按轮转推，不重放提子：一条四五手的变化里互相提子的情形罕见，
     *      真遇上也只是多画一颗子，不值得为此把整条变化摆一遍（Lizzieyzy 那边是
     *      真摆了盘，所以还多一层"被提的变化棋不画"的规则）。
     *
     * @param {Array<{x: number, y: number}>} pv [首选点, 后续…]（已解析成坐标）
     * @param {number[]} grid 当前显示局面的网格（0 空 / 1 黑 / 2 白）
     * @param {number} size 棋盘路数
     * @param {string|null} firstColor 变化第一手（首选）的颜色 'B'/'W'；未知按黑先
     * @returns {Array<{x: number, y: number, black: boolean, number: number}>}
     */
    function pvGhostStones(pv, grid, size, firstColor) {
      if (!Array.isArray(pv) || pv.length < 2) return []
      var out = []
      var black = firstColor !== 'W'
      for (var i = 1; i < pv.length; i++) {
        // 换手：第 1 手（首选）已由 firstColor 那方下过，第 i 手逐手轮转。
        // 必须放在 continue 之前 —— 跳过一子也要照常换手，不然颜色会串。
        black = !black
        var p = pv[i]
        if (p === null || p === undefined) continue
        if (grid[p.y * size + p.x] !== 0) continue
        out.push({ x: p.x, y: p.y, black: black, number: i + 1 })
      }
      return out
    }

    /** 变化线的文字（「改下 X 之后：N17 → Q5 → …」），三处视图共用。 */
    function aiLineText(list) {
      var best = Array.isArray(list) && list.length > 0 ? list[0] : null
      if (best === null || best === undefined) return ''
      var tokens = String(best.line == null ? '' : best.line).split(/\s+/).filter(function (t) { return t !== '' })
      return tokens.slice(1).join(' → ')
    }

    /**
     * 盘下那句 AI 说明。图例里把「AI 首选 / 变化图」关掉时返回空串 ——
     * 盘上已经没有那个记号了，文字留着只会让人以为漏画了。
     */
    function aiNoteText(list) {
      if (senseiStore.showHint === false) return ''
      return aiHintText(list)
    }

    /**
     * 在升序手数表里取上/下一处（走到头绕回另一端）。
     * 问题手与讲解两套跳转共用同一条规则，免得行为不一致。
     */
    function nextInList(list, cur, direction) {
      if (!Array.isArray(list) || list.length === 0) return null
      var i
      if (direction > 0) {
        for (i = 0; i < list.length; i++) {
          if (list[i] > cur) return list[i]
        }
        return list[0]
      }
      for (i = list.length - 1; i >= 0; i--) {
        if (list[i] < cur) return list[i]
      }
      return list[list.length - 1]
    }

    /**
     * 注释框：当前这一步有讲解时显示在棋盘下方。
     * 内容就是 go_write_review 写回棋谱的那段文字 —— 学生一边翻手一边读得到，
     * 不必再去打谱软件里翻 C[]。
     */
    function commentBox(text) {
      if (text === '') return null
      return React.createElement('div', { className: 'dgs-comment' },
        React.createElement('div', { className: 'dgs-comment-tag' }, '讲解（已写回棋谱注释）'),
        React.createElement('div', { className: 'dgs-comment-body' }, text))
    }

    /** 路径归一化：反斜杠转正斜杠、去掉尾部斜杠、转小写（Windows 大小写不敏感）。 */
    function normPath(path) {
      return String(path == null ? '' : path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /**
     * 判断两个路径是不是同一个文件。
     *
     * 只在文件名上比会把「两盘都叫 game.sgf 的棋」认成一盘（跳到错的手数而不是载入）；
     * 只在完整路径上比又会在「面板里是绝对路径、工具调用里是相对路径」时永远认不出，
     * 于是每轮都重新载入。所以：能整体相等或后缀包含就按路径认，剩下才退回文件名。
     */
    function sameFile(a, b) {
      var x = normPath(a)
      var y = normPath(b)
      if (x === '' || y === '') return false
      if (x === y) return true
      if (x.indexOf('/') < 0 || y.indexOf('/') < 0) return baseName(x) === baseName(y)
      return x.length > y.length ? x.endsWith('/' + y) : y.endsWith('/' + x)
    }

    /** 棋盘表头状态：「第 5/106 手 · 黑 Q16」。 */
    function boardStatusText(board, cur, move) {
      var total = board.moves.length
      if (cur <= 0) return '开局 · 共 ' + total + ' 手'
      var who = move && move.c === 'B' ? '黑' : '白'
      var where = move && move.x >= 0 ? boardLabel(move.x, move.y, board.size) : '虚着'
      return '第 ' + cur + '/' + total + ' 手 · ' + who + ' ' + where
    }

    /**
     * 「跟随讲解」游标（面板级）。
     * - seq：已经**应用**到棋盘的指针序号（同一件旧事不再重复应用）；
     * - seen：已经**见过**的最大序号（用户手动载入时用它把旧指针认掉）；
     * - failures：连续轮询失败次数（连接失效时用来给出可诊断的提示）；
     * - tried：失败过的自动载入，防止路径解析不了时每 3 秒重试一次。
     */
    var focusPointer = { seq: 0, seen: 0, failures: 0, tried: {} }

    // -----------------------------------------------------------------------
    // 两份 UI 的共享状态：输入框下方的面板（控制器）＋ 左侧栏点开的整页棋盘
    //
    // 为什么需要：同一个插件注册了两处 UI，它们得显示同一盘棋、同一手。
    // 宿主仍是数据的唯一来源（两边都从 /go-sensei/review 拿），但"现在停在第几手、
    // 棋盘展开没有、跟不跟随"这类**视图状态**必须共享，否则在一边翻手另一边不动，
    // 看着像两个程序。
    //
    // 面板是控制器（有路径输入、负责读取并把结果发布出来），整页是大视图。
    // 注意单测里的 React 桩把 useEffect 实现成空操作，所以"发布/订阅"在测试里
    // 不参与，面板的本地 state 依旧是它渲染的直接来源 —— 既有测试行为不变。
    // -----------------------------------------------------------------------
    /** 左侧栏图标位与主区域面板共用的 id（外壳按这个 id 把两者对上）。 */
    var PANEL_ID = 'go-sensei-board'
    var senseiStore = {
      data: null,
      path: '',
      upto: 0,
      // 面板自己展开/收起的状态也要共享：主区域一次只渲染一个面板，切到整页棋盘
      // 再切回来时 dock 是重新挂载的——不共享的话用户每次回来都要再点一次「展开」。
      open: false,
      follow: true,
      // 盘上标注的开关（三处视图共享）：问题手色点 / 讲解小方点 / AI 首选与变化图。
      // 三个都默认开——它们是讲解的主体；关掉是为了让盘面干净地看棋形。
      showProblem: true,
      showNote: true,
      showHint: true,
      // 两条曲线（胜率 / 目差，统一黑方视角）的展开态：三处视图同步，
      // 缺省展开（曲线本身就是这次新增的主角，收起只是"想让面板短一点"时的选择）。
      curveWinrate: true,
      curveScore: true,
      subs: [],
    }

    /** 写入共享状态，值真的变了才通知订阅者。 */
    function senseiPatch(patch) {
      var changed = false
      for (var key in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, key) && senseiStore[key] !== patch[key]) {
          senseiStore[key] = patch[key]
          changed = true
        }
      }
      if (!changed) return
      var subs = senseiStore.subs.slice()
      for (var i = 0; i < subs.length; i++) {
        try {
          subs[i]()
        } catch (error) {
          /* 一个订阅者出错不影响其它订阅者 */
        }
      }
    }

    /** 订阅共享状态；返回退订函数。 */
    function senseiSubscribe(fn) {
      senseiStore.subs.push(fn)
      return function () {
        var index = senseiStore.subs.indexOf(fn)
        if (index >= 0) senseiStore.subs.splice(index, 1)
      }
    }

    /** 组件里读取共享状态并跟随更新。 */
    function useSenseiStore() {
      var state = React.useState(0)
      var setTick = state[1]
      React.useEffect(function () {
        return senseiSubscribe(function () { setTick(function (n) { return n + 1 }) })
      }, [])
      return senseiStore
    }

    /** 图例里的小色样：点 / 方 / 圈，与盘上画法一一对应。 */
    function markerSwatch(kind, color) {
      var common = { width: 9, height: 9, viewBox: '0 0 10 10', 'aria-hidden': 'true' }
      if (kind === 'square') {
        return React.createElement('svg', common,
          React.createElement('rect', { x: 2, y: 2, width: 6, height: 6, fill: color }))
      }
      if (kind === 'ring') {
        return React.createElement('svg', common,
          React.createElement('circle', { cx: 5, cy: 5, r: 3.4, fill: 'none', stroke: color, strokeWidth: 1.6 }))
      }
      return React.createElement('svg', common,
        React.createElement('circle', { cx: 5, cy: 5, r: 3.4, fill: color }))
    }

    /**
     * 盘上标注的**图例 + 开关**（三处视图共用同一条）。
     *
     * 为什么要有它：盘上的记号多了以后，"这个点是什么意思"必须能就地查到，
     * 而且不同的人在不同的时候想看的记号不一样（想安静看棋形时就全关掉）。
     * 每项＝色样 + 名称，点一下切换；关掉的项变淡，点击后所有视图同步生效
     * （状态放在共享 store 里，不各存一份）。
     */
    var MARKS_KEY_ITEMS = [
      { key: 'showProblem', kind: 'dot', color: MARK_COLORS.blunder, label: '问题手（紫＞红＞橙）',
        hint: '已下过的着法里被评为问题的手：颜色越靠紫，错得越重' },
      { key: 'showNote', kind: 'square', color: '#7c8cff', label: '有讲解',
        hint: '棋谱写回注释的手（左上角小方点），只标已经下到的' },
      { key: 'showHint', kind: 'ring', color: BEST_RING, label: 'AI 首选 / 变化图',
        hint: '每一手（含讲解点）改下哪里：青圆蓝圈＝首选，橙底数字＝它的胜率，之后每手一颗半透明棋子、正中是它在这条变化里的序号（2、3…，黑棋白字）' },
    ]

    function markerKeyRow() {
      return React.createElement('div', { className: 'dgs-key' },
        MARKS_KEY_ITEMS.map(function (item) {
          var on = senseiStore[item.key] !== false
          return React.createElement('button', {
            key: item.key,
            className: on ? 'dgs-keyitem' : 'dgs-keyitem dgs-keyoff',
            title: (on ? '点击在棋盘上隐藏：' : '点击在棋盘上显示：') + item.hint,
            onClick: function () {
              var patch = {}
              patch[item.key] = !on
              senseiPatch(patch)
            },
          },
            markerSwatch(item.kind, item.color),
            React.createElement('span', null, item.label),
          )
        }),
      )
    }

    // -----------------------------------------------------------------------
    // 胜率 / 目差曲线（三处视图共用）
    //
    // 数据来自宿主：payload.curve = { winrate: number|null[], score: number|null[] }，
    // 下标 i 对应「第 i+1 手之后的局面」，**统一黑方视角**（正胜率/正目差 = 黑好）。
    // 口径换算只做一次、只做在宿主（棋谱里的 WV 是白方视角、DM 是黑方视角、
    // LZ 是落子者视角），浏览器这边只负责画。
    // -----------------------------------------------------------------------

    /** 曲线图视口（无量纲单位；宽度交给 CSS 收窄，高度按比例缩放，不会变形）。 */
    var CURVE_W = 480
    var CURVE_H = 96
    var CURVE_PAD = { left: 34, right: 8, top: 10, bottom: 16 }
    var CURVE_COLOR = { winrate: '#6b8afd', score: '#d29922' }

    /** 纵轴定义：胜率固定 0~100%；目差关于 0 对称（取整到 10 目一档）。 */
    function curveDomain(kind, values) {
      if (kind === 'winrate') {
        return { min: 0, max: 100, axis: [100, 50, 0], format: function (v) { return String(Math.round(v)) } }
      }
      var maxAbs = 5
      for (var i = 0; i < values.length; i++) {
        var v = values[i]
        if (typeof v === 'number' && Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v))
      }
      maxAbs = Math.max(10, Math.ceil(maxAbs / 10) * 10)
      return {
        min: -maxAbs, max: maxAbs, axis: [maxAbs, 0, -maxAbs],
        format: function (v) { return (v > 0 ? '+' : '') + String(Math.round(v)) },
      }
    }

    /** 一个数值的显示文本（曲线表头用）。 */
    function curveValueText(kind, v) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
      if (kind === 'winrate') return v.toFixed(1) + '%'
      return (v > 0 ? '+' : '') + v.toFixed(1) + ' 目'
    }

    /**
     * 画一张曲线图（SVG）。横轴＝手数，纵轴＝黑方视角的胜率／目差；
     * 问题手在曲线上以面色点标出；点图上任意位置跳到那一手。
     *
     * @param {object} opts { kind, values, cur, marks, onSeek }
     * @returns {object} React 元素
     */
    function renderCurve(opts) {
      var kind = opts.kind === 'score' ? 'score' : 'winrate'
      var values = Array.isArray(opts.values) ? opts.values : []
      var total = values.length
      var cur = Math.max(0, Math.min(Math.trunc(opts.cur) || 0, total))
      var domain = curveDomain(kind, values)
      var x0 = CURVE_PAD.left
      var x1 = CURVE_W - CURVE_PAD.right
      var y0 = CURVE_PAD.top
      var y1 = CURVE_H - CURVE_PAD.bottom
      var span = domain.max - domain.min
      var finite = function (v) { return typeof v === 'number' && Number.isFinite(v) }
      var xAt = function (i) { return total <= 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * (i / (total - 1)) }
      var yAt = function (v) { return y1 - ((v - domain.min) / span) * (y1 - y0) }
      var kids = []

      kids.push(React.createElement('rect', {
        key: 'bg', x: 0, y: 0, width: CURVE_W, height: CURVE_H, rx: 6, fill: 'transparent',
      }))
      // 横向刻度线 + 纵轴数值（中间那条虚一点：胜率 50% / 目差 0 是分界）
      domain.axis.forEach(function (v, i) {
        var y = yAt(v)
        var lineProps = {
          key: 'grid' + i, x1: x0, y1: y, x2: x1, y2: y,
          stroke: 'rgba(255,255,255,.16)',
          strokeWidth: i === 1 ? 0.7 : 0.45,
        }
        if (i === 1) lineProps.strokeDasharray = '3 3'
        kids.push(React.createElement('line', lineProps))
        kids.push(React.createElement('text', {
          key: 'glab' + i, x: x0 - 4, y: y + 2.6, fontSize: 7.5, fill: '#9aa4b2', textAnchor: 'end',
        }, domain.format(v)))
      })

      // 折线：缺口（该手没有数据）处断开，而不是把 null 连成一条假的直线
      var segments = []
      var seg = []
      for (var i = 0; i < total; i++) {
        if (finite(values[i])) {
          seg.push(xAt(i).toFixed(1) + ',' + yAt(values[i]).toFixed(1))
        } else if (seg.length > 0) {
          segments.push(seg)
          seg = []
        }
      }
      if (seg.length > 0) segments.push(seg)
      segments.forEach(function (points, index) {
        if (points.length === 1) {
          var parts = points[0].split(',')
          kids.push(React.createElement('circle', {
            key: 'pt' + index, cx: Number(parts[0]), cy: Number(parts[1]), r: 1.2, fill: CURVE_COLOR[kind],
          }))
          return
        }
        kids.push(React.createElement('polyline', {
          key: 'line' + index, points: points.join(' '), fill: 'none', stroke: CURVE_COLOR[kind],
          strokeWidth: 1.3, strokeLinejoin: 'round', strokeLinecap: 'round',
        }))
      })

      // 问题手：在曲线上点一个小面色点（与盘上色点同一套严重度配色）
      var marks = Array.isArray(opts.marks) ? opts.marks : []
      marks.forEach(function (m, index) {
        var at = (Math.trunc(m.n) || 0) - 1
        if (at < 0 || at >= total || !finite(values[at])) return
        kids.push(React.createElement('circle', {
          key: 'mark' + index, cx: xAt(at), cy: yAt(values[at]), r: 2,
          fill: m.color, stroke: '#12131a', strokeWidth: 0.5,
        }))
      })

      // 当前手：竖直虚线 + 圆点（三处视图跟着共享的 upto 走）
      if (cur >= 1 && cur <= total) {
        var cx = xAt(cur - 1)
        kids.push(React.createElement('line', {
          key: 'cursor', x1: cx, y1: y0, x2: cx, y2: y1,
          stroke: '#e8eaf0', strokeWidth: 0.7, strokeDasharray: '2 2',
        }))
        if (finite(values[cur - 1])) {
          kids.push(React.createElement('circle', {
            key: 'cursordot', cx: cx, cy: yAt(values[cur - 1]), r: 2.6,
            fill: '#e8eaf0', stroke: CURVE_COLOR[kind], strokeWidth: 1.2,
          }))
        }
      }

      // 横轴刻度：第 1 手 / 中间 / 末手（数量少时自动去重）
      var ticks = []
      var addTick = function (n) {
        if (!(n >= 1 && n <= total)) return
        for (var k = 0; k < ticks.length; k++) if (ticks[k].n === n) return
        ticks.push({ n: n, x: xAt(n - 1) })
      }
      addTick(1)
      addTick(Math.ceil(total / 2))
      addTick(total)
      ticks.forEach(function (t, index) {
        kids.push(React.createElement('text', {
          key: 'tick' + index, x: t.x, y: CURVE_H - 4, fontSize: 7.5, fill: '#9aa4b2', textAnchor: 'middle',
        }, String(t.n)))
      })

      // 点击定位：与棋盘「点交叉点」同一种手感
      if (typeof opts.onSeek === 'function' && total > 1) {
        kids.push(React.createElement('rect', {
          key: 'hit', className: 'dgs-chart-hit', x: x0, y: y0, width: x1 - x0, height: y1 - y0,
          fill: 'transparent',
          onClick: function (event) {
            try {
              var box = event.currentTarget.getBoundingClientRect()
              var px = ((event.clientX - box.left) / (box.width || 1)) * CURVE_W
              var n = Math.round(((px - x0) / (x1 - x0)) * (total - 1)) + 1
              opts.onSeek(Math.max(1, Math.min(total, n)))
            } catch (error) {
              /* 点击失败绝不影响面板 */
            }
          },
        }))
      }

      return React.createElement('svg', {
        className: 'dgs-chart', viewBox: '0 0 ' + CURVE_W + ' ' + CURVE_H,
        xmlns: 'http://www.w3.org/2000/svg', 'data-dgs-curve': kind,
      }, kids)
    }

    /** 一条曲线（表头可折叠 + 图）。没有可用数据时返回 null。 */
    function curveBlock(kind, title, values, cur, marks, onSeek) {
      if (!Array.isArray(values) || values.length === 0) return null
      var hasData = false
      for (var i = 0; i < values.length; i++) {
        if (typeof values[i] === 'number' && Number.isFinite(values[i])) { hasData = true; break }
      }
      if (!hasData) return null
      var openKey = kind === 'winrate' ? 'curveWinrate' : 'curveScore'
      var open = senseiStore[openKey] !== false
      var at = Math.max(0, Math.min(Math.trunc(cur) || 0, values.length))
      var head = React.createElement('button', {
        key: 'head',
        className: 'dgs-curvehead',
        title: open ? '收起这张曲线' : '展开（横轴＝手数，纵轴＝黑方视角）',
        onClick: function () {
          var patch = {}
          patch[openKey] = !open
          senseiPatch(patch)
        },
      },
        React.createElement('span', null, title + (open ? ' ▾' : ' ▸')),
        React.createElement('span', { className: 'dgs-val' },
          '第 ' + at + ' 手 ' + curveValueText(kind, at >= 1 ? values[at - 1] : null)),
      )
      return React.createElement('div', { key: kind, className: 'dgs-curve' }, head,
        open
          ? renderCurve({ kind: kind, values: values, cur: at, marks: marks, onSeek: onSeek })
          : null,
        open ? React.createElement('div', { className: 'dgs-chart-hint' }, '点图上任意位置可跳到那一手') : null)
    }

    /**
     * 两条曲线（胜率 + 目差）。宿主没给 curve 数据（老版本/纯棋理）时返回 null。
     * @param {object} data /go-sensei/review 的 data
     * @param {number} cur 当前手数
     * @param {function} onSeek 点图定位回调 (moveNumber) -> void
     */
    function curvesView(data, cur, onSeek) {
      if (!data || !data.curve) return null
      var marks = (Array.isArray(data.candidates) ? data.candidates : []).map(function (c) {
        return { n: c.moveNumber, color: markColor(c.labelKey, c.label) }
      })
      var kids = []
      var winrate = curveBlock('winrate', '胜率曲线（黑方）', data.curve.winrate, cur, marks, onSeek)
      var score = curveBlock('score', '目差曲线（正＝黑领先）', data.curve.score, cur, marks, onSeek)
      if (winrate !== null) kids.push(winrate)
      if (score !== null) kids.push(score)
      if (kids.length === 0) return null
      return React.createElement('div', { className: 'dgs-curves' }, kids)
    }

    /** 左侧栏的「Sensei 棋盘」图标：外壳给 size/active，配色随主题走。 */
    function SenseiPanelIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      var active = props !== null && props !== undefined && props.active === true
      return React.createElement('svg', {
        className: 'dgs-icon', width: size, height: size, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.1,
        'aria-hidden': 'true', opacity: active ? 1 : 0.82,
      },
        React.createElement('rect', { key: 'b', x: 1.6, y: 1.6, width: 12.8, height: 12.8, rx: 1.4 }),
        React.createElement('line', { key: 'h', x1: 1.6, y1: 8, x2: 14.4, y2: 8 }),
        React.createElement('line', { key: 'v', x1: 8, y1: 1.6, x2: 8, y2: 14.4 }),
        React.createElement('circle', { key: 's1', cx: 5.2, cy: 5.2, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { key: 's2', cx: 10.8, cy: 10.8, r: 1.5, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /** 由服务端读取到的候选，拼出可直接发送的追问语（末句同样要求配图，见 askPointText）。 */
    function followUpText(candidate, path) {
      var where = candidate.coordLabel ? '（这手下在 ' + candidate.coordLabel + '）' : ''
      var suggest = candidate.pv && candidate.pv[0] && candidate.pv[0].label
        ? '，AI 推荐 ' + candidate.pv[0].label
        : ''
      return '追问：第 ' + candidate.moveNumber + ' 手' + where + suggest
        + '，这手为什么不好？改下哪里会更好？请结合局面与候选变化讲解，'
        + '并画一张变化图（1、2、3…标出顺序，关键棋子用三角形标出）。'
        + (path ? '（棋谱：' + path + '）' : '')
    }

    /** 空实现：插槽 props 缺 inputActions 时的安全兜底。 */
    function noActions() {
      return {
        setDraft: function () {},
        addAttachments: function () { return false },
        removeAttachment: function () {},
        pruneAttachments: function () {},
        submit: function () {},
      }
    }

    /**
     * 整页棋盘（主区域面板）：棋盘在左、问题手详细说明在右。
     *
     * 与 dock 面板的分工：dock 负责"读棋谱 + 插入追问"（只有它拿得到 inputActions），
     * 这里负责"看得大、看得全"（没有输入框能力，所以点一行改为复制追问语）。
     * 两边共用 senseiStore，所以在哪边翻手、开关跟随，另一边立刻同步。
     */
    function SenseiBoardPage() {
      var store = useSenseiStore()
      var copyState = React.useState('')
      var copied = copyState[0]
      var setCopied = copyState[1]

      var data = store.data
      var board = data && data.board && Array.isArray(data.board.moves) ? data.board : null
      var list = data && Array.isArray(data.candidates) ? data.candidates : []
      var total = board === null ? 0 : board.moves.length
      var cur = Math.max(0, Math.min(store.upto, total))
      var curMove = board !== null && cur > 0 ? board.moves[cur - 1] : null
      // 有讲解的手（已写回棋谱的 C[] 注释）：跳转按钮与盘上小方点都用它
      var noteMoves = commentedMoves(data)
      var nextNote = nextInList(noteMoves, cur, 1)
      var prevNote = nextInList(noteMoves, cur, -1)
      var problem = null
      for (var pi = 0; pi < list.length; pi++) {
        if (list[pi].moveNumber === cur) { problem = list[pi]; break }
      }
      // AI 首选与变化图：问题手候选优先，其次用宿主给的逐手候选 ——
      // 盘上画的是**首选之后的后续几手**（不是第 2、3 个候选点）。
      var aiList = aiCandidatesAt(data, problem, cur)
      var hint = aiList.length > 0 ? aiList[0] : null
      var pvPoints = board === null ? [] : aiLinePoints(aiList, board.size)
      var problemMarks = []
      if (board !== null) {
        for (var mi = 0; mi < list.length; mi++) {
          var cand = list[mi]
          var mv = typeof cand.moveNumber === 'number' ? board.moves[cand.moveNumber - 1] : null
          if (mv !== undefined && mv !== null && mv.x >= 0) {
            problemMarks.push({ n: cand.moveNumber, x: mv.x, y: mv.y, color: markColor(cand.labelKey, cand.label) })
          }
        }
      }
      var problemMoves = []
      for (var qi = 0; qi < list.length; qi++) {
        if (typeof list[qi].moveNumber === 'number' && list[qi].moveNumber > 0) problemMoves.push(list[qi].moveNumber)
      }
      problemMoves.sort(function (a, b) { return a - b })
      var nextProblem = null
      var prevProblem = null
      if (problemMoves.length > 0) {
        for (var ni = 0; ni < problemMoves.length; ni++) {
          if (problemMoves[ni] > cur) { nextProblem = problemMoves[ni]; break }
        }
        if (nextProblem === null) nextProblem = problemMoves[0]
        for (var pj = problemMoves.length - 1; pj >= 0; pj--) {
          if (problemMoves[pj] < cur) { prevProblem = problemMoves[pj]; break }
        }
        if (prevProblem === null) prevProblem = problemMoves[problemMoves.length - 1]
      }

      /**
       * 整页视图自己也要轮询跟随：主区域一次只渲染一个面板，切到这一页时输入框下方
       * 那块面板已经被卸载（它的轮询也随之停了）。没有这一段，整页就成了"看着像跟随
       * 讲解开着、其实永远不动"。
       */
      function loadIntoStore(target, cwdOverride) {
        var wanted = String(target == null ? '' : target).trim()
        if (wanted === '') return
        var key = wanted + '|' + String(cwdOverride || '')
        var last = focusPointer.tried[key] || 0
        if (Date.now() - last < 20000) return
        focusPointer.tried[key] = Date.now()
        var url = '/go-sensei/review?path=' + encodeURIComponent(wanted)
          + (cwdOverride ? '&cwd=' + encodeURIComponent(cwdOverride) : '')
        fetch(url)
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (!body || body.ok !== true || !body.data) return
            var next = body.data
            var nextBoard = next.board && Array.isArray(next.board.moves) ? next.board : null
            var nextTotal = nextBoard === null ? 0 : nextBoard.moves.length
            var nextList = Array.isArray(next.candidates) ? next.candidates : []
            var worst = nextList.length > 0 && typeof nextList[0].moveNumber === 'number' ? nextList[0].moveNumber : 0
            senseiPatch({
              data: next, path: wanted,
              upto: worst > 0 ? Math.min(worst, nextTotal) : nextTotal,
            })
          })
          .catch(function () { /* 下一轮再试 */ })
      }

      function pollFocusPage() {
        fetch('/go-sensei/focus')
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            var f = body && body.ok === true ? body.focus : null
            if (!f || typeof f.seq !== 'number') return
            if (f.seq > focusPointer.seen) focusPointer.seen = f.seq
            if (f.seq <= focusPointer.seq) return
            focusPointer.seq = f.seq
            var loaded = senseiStore.data && senseiStore.data.path ? senseiStore.data.path : ''
            if (loaded !== '' && sameFile(loaded, f.path || f.name || '')) {
              if (typeof f.moveNumber === 'number' && f.moveNumber > 0) senseiPatch({ upto: f.moveNumber })
              return
            }
            loadIntoStore(f.path, f.cwd)
          })
          .catch(function () { /* 轮询失败静默重试 */ })
      }

      React.useEffect(function () {
        if (!store.follow) return undefined
        var timer = setInterval(pollFocusPage, 3000)
        pollFocusPage()
        return function () { clearInterval(timer) }
      }, [store.follow, store.data])

      function copyFollowUp(candidate) {
        var text = followUpText(candidate, data ? data.path : '')
        var done = function () { setCopied('已复制第 ' + candidate.moveNumber + ' 手的追问语——粘到下面的输入框回车即可') }
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { setCopied('复制失败：请手动选中文字') })
            return
          }
        } catch (error) {
          /* 走下面的兜底提示 */
        }
        setCopied('这段是本页要问的话，请手动复制：' + text)
      }

      var head = React.createElement('div', { className: 'dgs-page-head' },
        React.createElement('span', { className: 'dgs-title' }, 'DeepGo Sensei · 棋盘'),
        React.createElement('span', { className: 'dgs-sub' },
          board === null ? '还没有棋谱' : boardStatusText(board, cur, curMove)),
        React.createElement('span', { className: 'dgs-spacer' }),
        board === null ? null : React.createElement('button', {
          className: 'dgs-follow',
          title: '开启后：Sensei 在对话里讲到哪一盘、第几手，这里自动跟过去',
          onClick: function () { senseiPatch({ follow: !store.follow }) },
        }, store.follow ? '跟随讲解 ✓' : '跟随讲解 ✕'),
      )

      if (board === null) {
        return React.createElement('div', { className: 'dgs-page', 'data-dgs': '' }, head,
          React.createElement('div', { className: 'dgs-page-empty' },
            React.createElement('div', null, '这里放整页棋盘。还没有棋谱可以显示——两种方式任选：'),
            React.createElement('ul', null,
              React.createElement('li', null, '① 回到对话，在输入框下方的「DeepGo Sensei」面板里读一张棋谱；'),
              React.createElement('li', null, '② 或者直接让 Sensei 复盘一盘棋——右下角开着「跟随讲解」时，这里会自动载入它讲的那盘棋。')),
            React.createElement('div', { className: 'dgs-sub' }, '两边显示的是同一盘棋、同一手：在任一边翻手或开关跟随，另一边立刻同步。')))
      }

      var ctl = React.createElement('div', { className: 'dgs-ctl' },
        React.createElement('button', { onClick: function () { senseiPatch({ upto: 0 }) }, title: '回到开局' }, '⏮'),
        React.createElement('button', { onClick: function () { senseiPatch({ upto: Math.max(0, cur - 1) }) }, title: '上一手' }, '◀'),
        React.createElement('button', { onClick: function () { senseiPatch({ upto: Math.min(total, cur + 1) }) }, title: '下一手' }, '▶'),
        React.createElement('button', { onClick: function () { senseiPatch({ upto: total }) }, title: '跳到末手' }, '⏭'),
        React.createElement('button', {
          className: 'dgs-jump', disabled: prevProblem === null,
          title: prevProblem === null ? '这盘棋没有发现明显问题手' : '跳到上一个恶点（第 ' + prevProblem + ' 手）',
          onClick: function () { if (prevProblem !== null) senseiPatch({ upto: prevProblem }) },
        }, '◀恶点'),
        React.createElement('button', {
          className: 'dgs-jump', disabled: nextProblem === null,
          title: nextProblem === null ? '这盘棋没有发现明显问题手' : '跳到下一个恶点（第 ' + nextProblem + ' 手）',
          onClick: function () { if (nextProblem !== null) senseiPatch({ upto: nextProblem }) },
        }, '恶点▶'),
        React.createElement('button', {
          className: 'dgs-jump', disabled: prevNote === null,
          title: prevNote === null ? '这盘棋还没有写回讲解' : '跳到上一处讲解（第 ' + prevNote + ' 手）',
          onClick: function () { if (prevNote !== null) senseiPatch({ upto: prevNote }) },
        }, '◀讲解'),
        React.createElement('button', {
          className: 'dgs-jump', disabled: nextNote === null,
          title: nextNote === null ? '这盘棋还没有写回讲解' : '跳到下一处讲解（第 ' + nextNote + ' 手）',
          onClick: function () { if (nextNote !== null) senseiPatch({ upto: nextNote }) },
        }, '讲解▶'),
        React.createElement('input', {
          type: 'range', min: 0, max: total, value: cur,
          title: '拖动快速定位',
          onChange: function (event) { senseiPatch({ upto: Number(event.target.value) }) },
        }),
      )

      var rows = list.map(function (candidate, index) {
        var top = candidate.pv && candidate.pv[0] ? candidate.pv[0] : null
        var pvText = Array.isArray(candidate.pv) && candidate.pv.length > 0
          ? candidate.pv.map(function (p) { return String(p && p.label ? p.label : '') })
              .filter(function (t) { return t !== ''; }).join(' → ')
          : ''
        return React.createElement('button', {
          className: 'dgs-page-item',
          key: String(candidate.moveNumber) + '-' + index,
          title: '点击：棋盘跳到这一手，并复制追问语',
          onClick: function () {
            senseiPatch({ upto: candidate.moveNumber })
            copyFollowUp(candidate)
          },
        },
          React.createElement('div', { className: 'dgs-l1' },
            React.createElement('span', { className: 'dgs-mv' }, '第 ' + candidate.moveNumber + ' 手'),
            React.createElement('span', null, candidate.color === 'B' ? '黑' : '白'),
            React.createElement('span', { className: 'dgs-coord' }, candidate.coordLabel || candidate.coord || ''),
            React.createElement('span', {
              className: 'dgs-badge',
              style: { color: severityColor(candidate.label) },
            }, candidate.label || ''),
          ),
          React.createElement('div', { className: 'dgs-l2' },
            '−' + (candidate.winrateLoss == null ? '?' : candidate.winrateLoss) + '% 胜率'
            + (candidate.scoreLoss == null ? '' : ' · ' + candidate.scoreLoss + ' 目')
            + (top && top.label ? '　AI 首选 ' + String(top.label)
                + (top.winratePct == null ? '' : '（胜率 ' + String(top.winratePct) + '%）') : '')),
          pvText === '' ? null : React.createElement('div', { className: 'dgs-l2' }, '变化：' + pvText),
        )
      })

      return React.createElement('div', { className: 'dgs-page', 'data-dgs': '' }, head,
        copied === '' ? null : React.createElement('div', { className: 'dgs-ok' }, copied),
        React.createElement('div', { className: 'dgs-page-body' },
          React.createElement('div', { className: 'dgs-page-board' },
            renderBoard({
              board: board, upto: cur, problem: problemPointOf(problem, curMove),
              players: data.players,
              marks: problemMarks, pv: pvPoints,
              noteMoves: noteMoves, showProblem: senseiStore.showProblem, showNote: senseiStore.showNote, showHint: senseiStore.showHint,
              hintLabel: hint && hint.label ? hint.label : '',
              // 整页也没有输入框：点击交叉点改为复制追问语（与右侧栏一致）
              onPick: function (x, y) {
                var text = askPointText(data, cur, x, y)
                if (text === '') return
                var where = boardLabel(x, y, board.size)
                copyText(text,
                  function () { setCopied('已复制该点的追问语（' + where + '）——粘到输入框回车即可') },
                  function () { setCopied('复制失败：请手动选中') })
              },
            }),
            // 控件条贴着棋盘下沿（打谱软件的习惯），不再占掉顶部一整行
            ctl,
            React.createElement('div', { className: 'dgs-note' },
              problem !== null
                // 停在一处问题手上：把"实战下在哪、AI 想下哪、之后怎么走"一次念全
                // （与下方面板同一句话；两边措辞漂移过，学生看着会以为说的是两件事）
                ? React.createElement('span', null,
                    React.createElement('span', { className: 'dgs-prob' },
                      '○ 实战 ' + String(problem.moveNumber) + ' 手 ' + String(problem.coordLabel || '')),
                    hint && hint.label
                      ? React.createElement('span', null,
                          '　',
                          React.createElement('span', { className: 'dgs-rec' }, '◌ AI 首选 ' + String(hint.label)),
                          hint.winratePct == null ? '' : '（胜率 ' + String(hint.winratePct) + '%）',
                          aiLineText(aiList) === '' ? '' : '　后续：' + aiLineText(aiList))
                      : '　◌ AI 首选（青圆蓝圈）　半透明棋子＝变化图后续几手')
                : aiNoteText(aiList) !== ''
                  // 不是问题手但有 AI 候选（讲解点最常落在这里）：把首选与后续念出来
                  ? aiNoteText(aiList) + (aiLineText(aiList) === '' ? '' : '　后续：' + aiLineText(aiList))
                  : problemMarks.length > 0
                    ? '● 盘上色点＝问题手（紫＞红＞橙）：点右边任意一行跳过去'
                    : '未发现明显问题手'),
          ),
          React.createElement('div', { className: 'dgs-page-side' },
            curvesView(data, cur, function (n) { senseiPatch({ upto: n }) }),
            React.createElement('div', { className: 'dgs-page-list' },
              list.length === 0
                ? React.createElement('div', { className: 'dgs-sub' }, '这盘棋没有发现问题手')
                : rows),
          )),
        // 图例与讲解整幅排在页面底部：讲解是讲给学生看的内容，不能被挤成一条缝
        React.createElement('div', { className: 'dgs-page-foot' },
          React.createElement('div', { className: 'dgs-foothead' },
            markerKeyRow(),
            React.createElement('span', { className: 'dgs-sub' },
              String(data.moveCount || 0) + ' 手 · ' + list.length + ' 个问题手')),
          // 已写回棋谱的讲解：翻到哪一手读到哪一手
          commentBox(commentOf(data, cur)),
        ))
    }

    /** 问题手 + 当前手 → 棋盘上那个大圈的坐标（两侧 UI 共用）。 */
    function problemPointOf(problem, curMove) {
      if (problem === null || curMove === null || curMove === undefined || curMove.x < 0) return null
      return { x: curMove.x, y: curMove.y, key: problem.labelKey, label: problem.label }
    }

    /**
     * 复盘入口（composer dock）。展开后：路径输入 + 读取 + 问题手列表。
     * props.inputActions.setDraft 是「真正把文字写进输入框」的动词。
     */
    function SenseiPanel(props) {
      var actions = props && props.inputActions ? props.inputActions : noActions()
      // 订阅共享状态：盘上标注的三个开关一改，这里要跟着重画
      useSenseiStore()
      // 初值取自共享状态：面板可能因为切到整页棋盘而被卸载再挂回来
      // （主区域一次只渲染一个面板），那时它必须接着显示原来那盘棋、原来那一手。
      var state = React.useState(senseiStore.path)
      var path = state[0]
      var setPath = state[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var dataState = React.useState(senseiStore.data)
      var data = dataState[0]
      var setData = dataState[1]
      var errState = React.useState('')
      var err = errState[0]
      var setErr = errState[1]
      var hintState = React.useState('')
      var hint = hintState[0]
      var setHint = hintState[1]
      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var openState = React.useState(senseiStore.open)
      var open = openState[0]
      var setOpen = openState[1]
      // 曲线/棋盘显示到第几手（0 = 开局）；载入棋谱后默认停在最严重的问题手。
      // 这个手数是**共享状态**：面板里点一行，左侧栏整页的棋盘与曲线一起跟过去。
      var uptoState = React.useState(senseiStore.upto)
      var upto = uptoState[0]
      var setUpto = uptoState[1]
      // 跟随讲解：Sensei 讲到哪一手，棋盘就跳到哪一手
      var followState = React.useState(senseiStore.follow)
      var follow = followState[0]
      var setFollow = followState[1]
      // 跟随讲解连续失败时的如实说明（页面连接失效时不再静默）
      var followNoteState = React.useState('')
      var followNote = followNoteState[0]
      var setFollowNote = followNoteState[1]

      // 会话工作区根：客户端快照里没有 cwd 字段，这里只作「锦上添花」尝试；
      // 真正可靠的基准由 Host 用 tools/result 记下的工作区根提供。
      var cwd = ''
      // 会话 id：相对路径的解析基准由宿主按 id 反查（浏览器拿不到会话 cwd），
      // 这样重启后还没调用过任何 go_* 工具时也能直接读相对路径。
      var sessionId = ''
      try {
        var snapshot = props && typeof props.useSession === 'function'
          ? props.useSession(function (s) { return s })
          : null
        if (snapshot && snapshot.header && snapshot.header.cwd) cwd = String(snapshot.header.cwd)
        if (snapshot && snapshot.header && snapshot.header.id) sessionId = String(snapshot.header.id)
        else if (snapshot && snapshot.id) sessionId = String(snapshot.id)
      } catch (error) {
        cwd = ''
      }

      /**
       * 读取棋谱。cwdOverride 用于「跟随讲解」自动载入 —— 那时路径来自
       * 工具调用参数（可能是相对某个会话工作区的相对路径），基准与当前
       * 会话 cwd 未必相同，必须带上 Host 记下的那个。
       */
      function loadTarget(target, cwdOverride) {
        var wanted = String(target == null ? '' : target).trim()
        if (wanted === '') { setErr('请先填写 SGF 路径'); return }
        var base = String(cwdOverride == null ? '' : cwdOverride) || cwd
        setBusy(true); setErr(''); setNotice(''); setHint('')
        var url = '/go-sensei/review?path=' + encodeURIComponent(wanted)
          + (base ? '&cwd=' + encodeURIComponent(base) : '')
          + (sessionId ? '&session=' + encodeURIComponent(sessionId) : '')
        // 没有分析数据的棋谱要等宿主现场补算（真机实测 87 秒）。不给说明的话，
        // 按钮上一直写着「读取中…」，用户会以为卡死了。
        var slowTimer = setTimeout(function () {
          setHint('仍在读取：棋谱没有分析数据时，宿主会用 KataGo 现场补算（实测 1~2 分钟），算完自动出结果。')
        }, SLOW_HINT_DELAY)
        var done = function () { clearTimeout(slowTimer); setHint('') }
        fetch(url)
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            done()
            setBusy(false)
            if (body && body.ok === true) {
              setData(body.data)
              // 载入后停在哪一手：有问题手就停在**最严重的那一手**（讲解时最想看的就是
              // 它，盘上的标记也才立即可见），没有问题手才停在末手。
              var board = body.data && body.data.board ? body.data.board : null
              var total = board && Array.isArray(board.moves) ? board.moves.length : 0
              var list = body.data && Array.isArray(body.data.candidates) ? body.data.candidates : []
              var worst = list.length > 0 && typeof list[0].moveNumber === 'number' ? list[0].moveNumber : 0
              setUpto(worst > 0 ? Math.min(worst, total) : total)
            } else {
              setData(null)
              setErr(body && body.error ? String(body.error) : '读取失败')
              if (body && body.hint) setHint(String(body.hint))
            }
          })
          .catch(function (error) {
            done()
            setBusy(false); setData(null); setErr(String(error && error.message ? error.message : error))
          })
      }

      function load() {
        loadTarget(path, '')
        // 手动读取＝用户此刻的选择：把已经见过的指针「认掉」，免得下一次轮询
        // 又用同一件旧事（比如别的会话留下的指针）把用户刚选的棋谱换掉。
        // 只有**新**的讲解事件（seq 更大）才会再切走。
        focusPointer.seq = focusPointer.seen
      }

      /**
       * 跟随讲解：轮询 Host 记下的「正在讲解的局面」指针。
       *
       * 为什么是轮询而不是推送：讲解发生在服务端的工具调用里，棋盘在浏览器；
       * 两者之间没有现成的会话通道。这条指针只读内存、不读盘，3 秒一次的
       * 代价可以忽略，而且只在"面板展开 + 跟随开启"时才轮询。
       */
      function pollFocus() {
        fetch('/go-sensei/focus')
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (focusPointer.failures > 0) {
              focusPointer.failures = 0
              setFollowNote('')
            }
            var f = body && body.ok === true ? body.focus : null
            if (!f || typeof f.seq !== 'number') return
            if (f.seq > focusPointer.seen) focusPointer.seen = f.seq
            // seq 不比"已应用"更新就什么都不做：同一件旧事不该反复抢走用户选的棋谱
            if (f.seq <= focusPointer.seq) return
            focusPointer.seq = f.seq
            applyFocus(f)
          })
          .catch(function () {
            // 页面连接失效时（实测：dsh web 重启后浏览器对同源的连接池会废掉）
            // 轮询会一直失败。以前是静默重试，用户看到的就是"跟随讲解没反应"——
            // 连失败三次就把话说清楚，并给出唯一的恢复手段。
            focusPointer.failures = (focusPointer.failures || 0) + 1
            if (focusPointer.failures >= 3) {
              setFollowNote('跟随讲解：连续 ' + focusPointer.failures + ' 次没连上宿主——页面连接可能已失效，刷新页面（F5）即可恢复。')
            }
          })
      }

      /** 把指针落到面板上：同一盘棋就跳手数（曲线与整页棋盘一起跟过去），另一盘棋就自动载入。 */
      function applyFocus(f) {
        var sameGame = data && data.path ? sameFile(data.path, f.path || f.name || '') : false
        if (!sameGame) {
          // 别急着反复重试：路径解析不了时（相对路径基准不对）20 秒内只试一次
          var key = String(f.path || '') + '|' + String(f.cwd || '')
          var last = focusPointer.tried[key] || 0
          if (Date.now() - last < 20000) return
          focusPointer.tried[key] = Date.now()
          setPath(String(f.path || ''))
          loadTarget(f.path, f.cwd)
          return
        }
        if (typeof f.moveNumber === 'number' && f.moveNumber > 0) setUpto(f.moveNumber)
      }

      React.useEffect(function () {
        // 棋盘已移到左侧栏整页，本面板只负责"读取 + 插入追问 + 显示曲线"：
        // 只要展开且开着跟随就轮询 —— 否则 Sensei 讲的棋永远带不进来。
        if (!open || !follow) return undefined
        var timer = setInterval(pollFocus, 3000)
        pollFocus()
        return function () { clearInterval(timer) }
      }, [open, follow, data])

      /**
       * 面板 → 共享状态：把当前这盘棋、这一手、开关与曲线展开态发布给整页棋盘。
       * 放在 effect 里（而不是渲染期）是必须的：渲染期改别人的状态，React 会报
       * "Cannot update a component while rendering a different component"。
       */
      React.useEffect(function () {
        senseiPatch({
          data: data, path: path, upto: upto,
          open: open, follow: follow,
        })
      }, [data, path, upto, open, follow])

      /** 共享状态 → 面板：整页棋盘那边翻手/开关时跟着走（比较后再 set，避免打转）。 */
      React.useEffect(function () {
        return senseiSubscribe(function () {
          if (senseiStore.open !== open) setOpen(senseiStore.open)
          if (senseiStore.upto !== upto) setUpto(senseiStore.upto)
          if (senseiStore.follow !== follow) setFollow(senseiStore.follow)
        })
      }, [open, upto, follow])

      var head = React.createElement('div', { className: 'dgs-head' },
        React.createElement('span', { className: 'dgs-title' }, 'DeepGo Sensei'),
        React.createElement('span', { className: 'dgs-sub' }, '读取棋谱 · 曲线在这 · 棋盘与问题手在左侧栏'),
        React.createElement('span', { className: 'dgs-spacer' }),
        React.createElement('button', { onClick: function () { setOpen(!open) } }, open ? '收起' : '展开'),
      )

      if (!open) return React.createElement('div', { 'data-dgs': '' }, head)

      var kids = [
        React.createElement('div', { className: 'dgs-row', key: 'p' },
          React.createElement('input', {
            value: path,
            placeholder: 'SGF 路径（相对工作区或绝对路径）',
            onChange: function (event) { setPath(event.target.value) },
            onKeyDown: function (event) { if (event.key === 'Enter') load() },
          }),
          React.createElement('button', { onClick: load, disabled: busy }, busy ? '读取中…' : '读取问题手'),
        ),
      ]
      if (notice) kids.push(React.createElement('div', { className: 'dgs-ok', key: 'n' }, notice))
      if (err) kids.push(React.createElement('div', { className: 'dgs-err', key: 'e' }, err))
      if (hint) kids.push(React.createElement('div', { className: 'dgs-sub', key: 'h' }, hint))

      // 当前手数与问题手位置：只用来做表头文字与曲线上的定位。
      // **棋盘与问题手列表都不在这里**（用户 2026-09-14：下方面板只保留「输入 SGF
      // 路径读取棋谱」+ 状态 + 两条曲线）——棋盘和列表交给左侧栏「Sensei 棋盘」整页，
      // 那边位置大、列表能一路看下去；面板是输入框旁边的一块，塞列表只会把曲线挤没。
      var list = data && Array.isArray(data.candidates) ? data.candidates : []
      var board = data && data.board && Array.isArray(data.board.moves) ? data.board : null
      var total = board === null ? 0 : board.moves.length
      var cur = Math.max(0, Math.min(upto, total))
      var curMove = board !== null && cur > 0 ? board.moves[cur - 1] : null

      // ── 状态行：棋谱状态 + 跟随开关（未载入棋谱时也要在，跟随是唯一的自动入口）──
      kids.push(React.createElement('div', { className: 'dgs-boardwrap', key: 'status' },
        React.createElement('div', { className: 'dgs-boardhead' },
          React.createElement('span', { className: 'dgs-sub' },
            board === null ? '未载入棋谱' : boardStatusText(board, cur, curMove)),
          React.createElement('button', {
            className: 'dgs-follow',
            title: '开启后：Sensei 在对话里讲到哪一盘、第几手，这里自动读进来并同步给整页棋盘',
            onClick: function () { setFollow(!follow) },
          }, follow ? '跟随讲解 ✓' : '跟随讲解 ✕'),
        ),
      ))

      if (followNote) {
        kids.push(React.createElement('div', { className: 'dgs-err', key: 'follownote' }, followNote))
      }

      if (board === null && data === null) {
        kids.push(React.createElement('div', { className: 'dgs-sub', key: 'noboard' },
          follow
            ? '跟随讲解已开：Sensei 在对话里读到哪盘棋，这里会自动读进来。也可以在上面填路径点「读取问题手」。'
            : '还没有棋谱：填路径后点「读取问题手」，或把「跟随讲解」打开，等 Sensei 讲到一盘棋时自动载入。'))
      }

      if (data) {
        // 补算状态照实显示：这类"读不到"的抱怨里，最需要一眼看清的就是
        // "宿主到底补算没有、补算成功没有"，否则用户只能看到「纯棋理 · 0 个问题手」。
        var auto = data.autoEngine && typeof data.autoEngine === 'object' ? data.autoEngine : null
        var autoText = ''
        if (auto !== null && auto.failed !== undefined) {
          autoText = ' · 补算未成功：' + String(auto.failed).slice(0, 40)
        } else if (auto !== null && typeof auto.moves === 'number') {
          autoText = ' · 引擎补算 ' + String(auto.moves) + ' 手'
            + (auto.seconds == null ? '' : '（' + String(auto.seconds) + ' 秒）')
        }
        kids.push(React.createElement('div', { className: 'dgs-sub', key: 'meta' },
          (data.mode === 'analysis' ? 'AI 分析' : '纯棋理') + ' · 难度 ' + String(data.level || '-')
          + ' · ' + String(data.moveCount || 0) + ' 手 / ' + String(data.variations || 0) + ' 变化图'
          + ' · ' + list.length + ' 个问题手' + autoText))

        // 曲线与棋盘都在左侧栏「Sensei 棋盘」整页里看；这里也给两条曲线，
        // 因为"这盘棋大势怎么走的"是一眼就该看到的东西（点图可定位到那一手）。
        var curves = curvesView(data, cur, function (n) { setUpto(n) })
        if (curves !== null) kids.push(React.createElement('div', { key: 'curves' }, curves))

        var listEl = null
        if (list.length === 0) {
          // 列表去掉了，但"为什么一个点都没有"还是要说清楚：补算失败与纯棋理
          // 长得一模一样，用户只会看到 0 个问题手。
          listEl = React.createElement('div', { className: 'dgs-sub', key: 'none' },
            data.mode === 'analysis'
              ? '未发现明显问题手'
              : auto !== null && auto.failed !== undefined
                ? '棋谱没有可用的分析数据，补算也没成功（原因见上一行）'
                : '棋谱没有可用的分析数据：这一档只能讲棋理，不报胜率与候选点')
        }
        if (listEl !== null) kids.push(listEl)
      }

      return React.createElement('div', { 'data-dgs': '' }, head,
        React.createElement('div', null, kids))
    }

    /** 注册到 composer dock 与左侧栏面板位；React/slots 缺席时静默跳过。 */
    function registerPanel(ctx) {
      if (React === null || typeof React.createElement !== 'function') return
      var slots = ctx.get('slots')
      if (slots === undefined || typeof slots.inject !== 'function') return
      ensureStyles()
      // ① 输入框下方的面板：负责读取棋谱、插入追问（只有 composer 系列插槽给 inputActions）
      slots.inject('conversation.composer.dock', function () {
        return slots.register(
          { name: 'conversation.composer.dock', id: 'go-sensei-panel' },
          SenseiPanel,
        )
      })
      // ② 左侧栏的「Sensei 棋盘」图标位：外壳自己渲染按钮与标签、自己负责切主区域，
      //    我们只画图标 —— 这样不会和原生侧边栏抢位置（叠加式注册，replaceRisk 为 none）
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: 'Sensei 棋盘' },
          SenseiPanelIcon,
        )
      })
      // ③ 对应的主区域面板：棋盘在左、问题手详细说明在右（keyed 插槽，新 key 不覆盖 conversation）
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: PANEL_ID }, SenseiBoardPage)
      })
    }

    // -----------------------------------------------------------------------
    // 右侧栏：为 .sgf 注册一个原生「文档」预览实现
    //
    // 平台事实（读 dsh-client-ui-sidebar-documentpreview 的产物确认，第三方插件
    // 唯一能进右侧栏的正路 —— 侧栏标签页的创建是外壳内部的东西，插件开不了）：
    //   · ctx.documentPreviews.register({ id, extensions, priority, title, loading, wrap })
    //     匹配规则：priority !== 'builtin' 属"外部档"排前，然后比最长后缀，再按注册顺序；
    //     .sgf 没有内置实现抢，所以这一条会胜出。
    //   · 正文注册进 sidebar.right.tab.document，key = 定义的 id；
    //     props 给 { resourceAddress, content, wrap, scrollportRef, useTabInfo }，
    //     其中 resourceAddress 形如 dsh-resource://file/session/<会话>/<路径>。
    // 于是：在对话里点文件的「打开」（或文件列表里点开 .sgf）→ 棋盘出现在右侧栏，
    // 对话留在左边。这正是"左右排版"的原生做法，不遮挡任何原生控件。
    // -----------------------------------------------------------------------

    /** 右侧栏文档正文的注册 key（与文档预览定义的 id 同一个值）。 */
    var DOC_BODY_ID = 'dsh-go-sensei/board'

    /**
     * dsh-resource 文件地址 → 会话 id。
     * 右侧栏文档给的是会话内相对路径，宿主得靠这个 id 反查工作区根才能解析
     * （客户端没有会话 cwd）。
     * @param {string} address 形如 dsh-resource://file/session/<id>/<路径>
     * @returns {string} 会话 id；不是会话文件地址时返回空串
     */
    function sessionIdOfAddress(address) {
      var prefix = 'dsh-resource://file/'
      var text = String(address == null ? '' : address)
      if (text.indexOf(prefix) !== 0) return ''
      var end = text.search(/[?#]/)
      var parts = text.slice(prefix.length, end === -1 ? undefined : end).split('/')
      if (parts[0] !== 'session') return ''
      var id = parts[1]
      if (id === undefined || id === '') return ''
      try {
        return decodeURIComponent(id)
      } catch (error) {
        return id
      }
    }

    /**
     * dsh-resource 文件地址 → 文件路径。
     * 与官方 parseFileAddress 同规则：前缀 20 字符，第二段是 scope，
     * 第三段是会话 id，其余各段解码后用 '/' 拼回路径（Windows 盘符是一段，如 'C:'）。
     * @param {string} address 形如 dsh-resource://file/session/<id>/C:/dir/a.sgf
     * @returns {string} 文件路径；不是会话文件地址时返回空串
     */
    function filePathOfAddress(address) {
      var prefix = 'dsh-resource://file/'
      var text = String(address == null ? '' : address)
      if (text.indexOf(prefix) !== 0) return ''
      var end = text.search(/[?#]/)
      var parts = text.slice(prefix.length, end === -1 ? undefined : end).split('/')
      if (parts[0] !== 'session') return ''
      var segments = parts.slice(2)
      if (segments.length === 0) return ''
      var decoded = []
      for (var i = 0; i < segments.length; i++) {
        try {
          decoded.push(decodeURIComponent(segments[i]))
        } catch (error) {
          decoded.push(segments[i])
        }
      }
      return decoded.join('/')
    }

    /**
     * 右侧栏文档正文：一块纵向排布的棋盘（棋盘在上、问题手列表在下）。
     * 与输入框下方那块不同，这里没有 inputActions，所以点行改为复制追问语。
     */
    function SenseiDocumentBody(props) {
      var path = filePathOfAddress(props && props.resourceAddress)
      var sessionId = sessionIdOfAddress(props && props.resourceAddress)
      // 订阅共享状态：盘上标注的三个开关一改，右侧栏这块也要跟着重画
      useSenseiStore()
      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errState = React.useState('')
      var err = errState[0]
      var setErr = errState[1]
      var uptoState = React.useState(0)
      var upto = uptoState[0]
      var setUpto = uptoState[1]
      var followState = React.useState(true)
      var follow = followState[0]
      var setFollow = followState[1]
      var copiedState = React.useState('')
      var copied = copiedState[0]
      var setCopied = copiedState[1]

      React.useEffect(function () {
        if (path === '') return undefined
        var alive = true
        setBusy(true); setErr(''); setData(null); setUpto(0)
        // 带上会话 id：文档地址里的路径是会话内相对路径，宿主靠这个反查工作区根
        fetch('/go-sensei/review?path=' + encodeURIComponent(path)
          + (sessionId ? '&session=' + encodeURIComponent(sessionId) : ''))
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (!alive) return
            setBusy(false)
            if (!body || body.ok !== true) {
              setErr(body && body.error ? String(body.error) : '读取失败')
              return
            }
            var next = body.data
            var board = next && next.board && Array.isArray(next.board.moves) ? next.board : null
            var total = board === null ? 0 : board.moves.length
            var list = next && Array.isArray(next.candidates) ? next.candidates : []
            var worst = list.length > 0 && typeof list[0].moveNumber === 'number' ? list[0].moveNumber : 0
            setData(next)
            setUpto(worst > 0 ? Math.min(worst, total) : total)
          })
          .catch(function (error) {
            if (!alive) return
            setBusy(false); setErr(String(error && error.message ? error.message : error))
          })
        return function () { alive = false }
      }, [path])

      function pollFocusDoc() {
        fetch('/go-sensei/focus')
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            var f = body && body.ok === true ? body.focus : null
            if (!f || typeof f.seq !== 'number') return
            if (f.seq > focusPointer.seen) focusPointer.seen = f.seq
            if (f.seq <= focusPointer.seq) return
            focusPointer.seq = f.seq
            if (path !== '' && sameFile(path, f.path || f.name || '')) {
              if (typeof f.moveNumber === 'number' && f.moveNumber > 0) setUpto(f.moveNumber)
            }
          })
          .catch(function () { /* 轮询失败静默重试 */ })
      }

      React.useEffect(function () {
        if (!follow || path === '') return undefined
        var timer = setInterval(pollFocusDoc, 3000)
        pollFocusDoc()
        return function () { clearInterval(timer) }
      }, [follow, path])

      function copyFollowUpDoc(candidate) {
        var text = followUpText(candidate, path)
        copyText(text,
          function () { setCopied('已复制第 ' + candidate.moveNumber + ' 手的追问语') },
          function () { setCopied('复制失败：请手动选中') })
      }

      /**
       * 点棋盘交叉点 → 就该点复制一句追问（右侧栏没有输入框，所以是复制而不是插入）。
       * 与输入框下方面板同一个动作，只是那边直接插进输入框。
       */
      function askPointDoc(x, y) {
        var text = askPointText(data, cur, x, y)
        if (text === '') return
        var label = board !== null ? boardLabel(x, y, board.size) : ''
        copyText(text,
          function () { setCopied('已复制该点的追问语（' + label + '）——粘到输入框回车即可') },
          function () { setCopied('复制失败：请手动选中') })
      }

      if (path === '') {
        return React.createElement('div', { className: 'dgs-doc' },
          React.createElement('div', { className: 'dgs-sub' }, 'Sensei 棋盘：这个标签页的文件地址无法解析。'))
      }

      var board = data && data.board && Array.isArray(data.board.moves) ? data.board : null
      var total = board === null ? 0 : board.moves.length
      var cur = Math.max(0, Math.min(upto, total))
      var curMove = board !== null && cur > 0 ? board.moves[cur - 1] : null
      var list = data && Array.isArray(data.candidates) ? data.candidates : []
      var problem = null
      for (var i = 0; i < list.length; i++) {
        if (list[i].moveNumber === cur) { problem = list[i]; break }
      }
      // AI 首选与变化图：问题手候选优先，其次用宿主给的逐手候选（讲解点也能标）；
      // 盘上画首选之后的后续几手，不是第 2、3 个候选点。
      var aiList = aiCandidatesAt(data, problem, cur)
      var hint = aiList.length > 0 ? aiList[0] : null
      var pvPoints = board === null ? [] : aiLinePoints(aiList, board.size)
      var problemPoint = problem !== null && curMove !== null && curMove.x >= 0
        ? { x: curMove.x, y: curMove.y, key: problem.labelKey, label: problem.label }
        : null
      var problemMoves = list.map(function (c) { return c.moveNumber }).filter(function (n) {
        return typeof n === 'number'
      }).sort(function (a, b) { return a - b })
      // 盘上的问题手色点（与 dock / 整页同一套语义：全盘问题一眼可数）
      var problemMarks = []
      if (board !== null) {
        for (var mi = 0; mi < list.length; mi++) {
          var cand = list[mi]
          var mv = typeof cand.moveNumber === 'number' ? board.moves[cand.moveNumber - 1] : null
          if (mv !== undefined && mv !== null && mv.x >= 0) {
            problemMarks.push({ n: cand.moveNumber, x: mv.x, y: mv.y, color: markColor(cand.labelKey, cand.label) })
          }
        }
      }
      // 有讲解的手（已写回棋谱的 C[] 注释）：跳转按钮与盘上小方点都用它
      var noteMoves = commentedMoves(data)

      function jumpProblem(direction) {
        if (problemMoves.length === 0) return
        var target = null
        var k
        if (direction > 0) {
          for (k = 0; k < problemMoves.length; k++) {
            if (problemMoves[k] > cur) { target = problemMoves[k]; break }
          }
          if (target === null) target = problemMoves[0]
        } else {
          for (k = problemMoves.length - 1; k >= 0; k--) {
            if (problemMoves[k] < cur) { target = problemMoves[k]; break }
          }
          if (target === null) target = problemMoves[problemMoves.length - 1]
        }
        setUpto(target)
      }

      var kids = [
        React.createElement('div', { className: 'dgs-doc-head', key: 'h' },
          React.createElement('span', { className: 'dgs-title' }, 'Sensei 棋盘'),
          React.createElement('span', { className: 'dgs-sub' }, baseName(path)),
          React.createElement('span', { className: 'dgs-spacer' }),
          React.createElement('button', {
            className: 'dgs-follow',
            title: '开启后：Sensei 在对话里讲到第几手，这里就跟到第几手',
            onClick: function () { setFollow(!follow) },
          }, follow ? '跟随讲解 ✓' : '跟随讲解 ✕'),
        ),
      ]
      if (busy) kids.push(React.createElement('div', { className: 'dgs-sub', key: 'b' }, '读取中…'))
      if (err) kids.push(React.createElement('div', { className: 'dgs-err', key: 'e' }, err))
      if (copied) kids.push(React.createElement('div', { className: 'dgs-ok', key: 'c' }, copied))

      if (board !== null) {
        kids.push(React.createElement('div', { className: 'dgs-doc-status', key: 's' },
          boardStatusText(board, cur, curMove),
          data.mode === 'analysis' ? ' · AI 分析' : ' · 纯棋理'))
        // 左列＝棋盘 + 控件条（同宽同中：两边各自居中会让控件与棋盘对不齐，
        // 用户报过「控件有偏移」）。曲线是右列，见下面的 .dgs-doc-inner 组装。
        var main = [
          React.createElement('div', { className: 'dgs-doc-board', key: 'bd' },
            renderBoard({
              board: board,
              upto: cur,
              problem: problemPoint,
              players: data.players,
              marks: problemMarks,
              pv: pvPoints,
              noteMoves: noteMoves, showProblem: senseiStore.showProblem, showNote: senseiStore.showNote, showHint: senseiStore.showHint,
              hintLabel: hint && hint.label ? hint.label : '',
              onPick: askPointDoc,
            })),
        ]
        var ctl = React.createElement('div', { className: 'dgs-ctl', key: 'ctl' },
          React.createElement('button', { onClick: function () { setUpto(0) }, title: '回到开局' }, '⏮'),
          React.createElement('button', { onClick: function () { setUpto(Math.max(0, cur - 1)) }, title: '上一手' }, '◀'),
          React.createElement('button', { onClick: function () { setUpto(Math.min(total, cur + 1)) }, title: '下一手' }, '▶'),
          React.createElement('button', { onClick: function () { setUpto(total) }, title: '跳到末手' }, '⏭'),
          React.createElement('button', {
            className: 'dgs-jump', disabled: problemMoves.length === 0,
            onClick: function () { jumpProblem(-1) }, title: '上一处问题手',
          }, '◀恶点'),
          React.createElement('button', {
            className: 'dgs-jump', disabled: problemMoves.length === 0,
            onClick: function () { jumpProblem(1) }, title: '下一处问题手',
          }, '恶点▶'),
          React.createElement('button', {
            className: 'dgs-jump', disabled: noteMoves.length === 0,
            onClick: function () {
              var target = nextInList(noteMoves, cur, -1)
              if (target !== null) setUpto(target)
            },
            title: noteMoves.length === 0 ? '这盘棋还没有写回讲解' : '上一处讲解',
          }, '◀讲解'),
          React.createElement('button', {
            className: 'dgs-jump', disabled: noteMoves.length === 0,
            onClick: function () {
              var target = nextInList(noteMoves, cur, 1)
              if (target !== null) setUpto(target)
            },
            title: noteMoves.length === 0 ? '这盘棋还没有写回讲解' : '下一处讲解',
          }, '讲解▶'),
          React.createElement('input', {
            type: 'range', min: 0, max: total, value: cur,
            onChange: function (event) { setUpto(Number(event.target.value)) },
          }))
        main.push(ctl)
        // 胜率 / 目差曲线（可折叠）＝右列：右侧栏够宽就与棋盘并排，
        // 拖窄了自动折回棋盘下方（用户 2026-09-14 选的方案 A）
        var docCurves = curvesView(data, cur, function (n) { setUpto(n) })
        var inner = [React.createElement('div', { className: 'dgs-doc-main', key: 'main' }, main)]
        if (docCurves !== null) inner.push(docCurves)
        kids.push(React.createElement('div', { className: 'dgs-doc-inner', key: 'inner' }, inner))
        // AI 首选与变化图：问题手要说，讲解点（未必是问题手）同样要说
        var aiText = aiNoteText(aiList)
        if (problem !== null || aiText !== '') {
          kids.push(React.createElement('div', { className: 'dgs-note', key: 'n' },
            problem !== null
              ? React.createElement('span', { className: 'dgs-prob' },
                  '○ 实战 ' + String(problem.moveNumber) + ' 手 ' + String(problem.coordLabel || ''))
              : null,
            aiText === ''
              ? null
              : React.createElement('span', { className: 'dgs-rec' },
                  (problem !== null ? '　' : '') + aiText
                  + (aiLineText(aiList) === '' ? '' : '　后续：' + aiLineText(aiList)))))
        }
        // 盘上标注的图例 + 手数小结 + 已写回棋谱的讲解：合成底部一块，
        // 讲解因此总有一整行高度（右侧栏窄，单独摆一条很容易被当成行间小字漏掉）。
        var noteBox = commentBox(commentOf(data, cur))
        kids.push(React.createElement('div', { className: 'dgs-doc-foot', key: 'foot' },
          React.createElement('div', { className: 'dgs-foothead' },
            markerKeyRow(),
            React.createElement('div', { className: 'dgs-sub' },
              String(data.moveCount || 0) + ' 手 · ' + list.length + ' 个问题手'
              + (data.autoEngine ? ' · 引擎补算 ' + String(data.autoEngine.moves ?? '') + ' 手'
                + (data.autoEngine.cached === true ? '（本次复用，未重算）' : '') : ''))),
          noteBox !== null ? noteBox : React.createElement('div', { className: 'dgs-sub' },
            '这一手还没有写回讲解：点列表里的问题手，或让 Sensei 讲完再写回棋谱。'),
        ))
        kids.push(React.createElement('div', { className: 'dgs-list dgs-doc-list', key: 'list' },
          list.map(function (candidate, index) {
            var top = candidate.pv && candidate.pv[0] ? candidate.pv[0] : null
            return React.createElement('button', {
              className: 'dgs-item',
              key: String(candidate.moveNumber) + '-' + index,
              title: '点击：棋盘跳到这一手，并复制追问语',
              onClick: function () {
                setUpto(candidate.moveNumber)
                copyFollowUpDoc(candidate)
              },
            },
              React.createElement('div', { className: 'dgs-l1' },
                React.createElement('span', { className: 'dgs-mv' }, '第 ' + candidate.moveNumber + ' 手'),
                React.createElement('span', null, candidate.color === 'B' ? '黑' : '白'),
                React.createElement('span', { className: 'dgs-coord' }, candidate.coordLabel || candidate.coord || ''),
                React.createElement('span', {
                  className: 'dgs-badge',
                  style: { color: severityColor(candidate.label) },
                }, candidate.label || '')),
              React.createElement('div', { className: 'dgs-l2' },
                '−' + (candidate.winrateLoss == null ? '?' : candidate.winrateLoss) + '% 胜率'
                + (candidate.scoreLoss == null ? '' : ' / ' + candidate.scoreLoss + ' 目')
                + (top && top.label ? ' · AI 首选：' + top.label : ''),
                commentOf(data, candidate.moveNumber) !== ''
                  ? React.createElement('span', { className: 'dgs-hasnote' }, ' · 有讲解')
                  : null))
          })))
      } else if (!busy && err === '') {
        kids.push(React.createElement('div', { className: 'dgs-sub', key: 'w' }, '正在准备棋盘…'))
      }
      return React.createElement('div', { className: 'dgs-doc', 'data-dgs': '' }, kids)
    }

    /**
     * 注册 .sgf 的文档预览实现（右侧栏）。
     *
     * 用 ctx.inject 等 documentPreviews 出现再注册，而不是一开始就 ctx.get：
     * 客户端服务按挂载顺序出现，本插件的 apply 完全可能早于提供该服务的官方
     * 文档预览包 —— 早一步 get 就是 undefined，注册会被静默跳过（真机实测踩过：
     * 产物里有代码、右侧栏却仍是纯文本预览）。
     * 无 inject 的极简上下文（单测桩）退回即时 get。
     */
    function registerDocumentPreview(ctx) {
      if (React === null || typeof React.createElement !== 'function') return
      var mount = function (scoped) {
        var host = scoped === undefined ? ctx : scoped
        var documents = host.get('documentPreviews')
        if (documents === undefined || typeof documents.register !== 'function') return
        var slots = host.get('slots')
        if (slots === undefined || typeof slots.register !== 'function') return
        ensureStyles()
        var definition = {
          id: DOC_BODY_ID,
          extensions: ['sgf'],
          // 非 'builtin' 即"外部档"：比内置兜底优先，且 .sgf 没有内置实现抢
          priority: 'external',
          title: function () { return 'Sensei 棋盘' },
          loading: 'text-pages',
          wrap: false,
        }
        if (typeof host.effect === 'function') host.effect(function () { return documents.register(definition) })
        else documents.register(definition)
        slots.inject('sidebar.right.tab.document', function () {
          return slots.register({ name: 'sidebar.right.tab.document', key: DOC_BODY_ID }, SenseiDocumentBody)
        })
      }
      if (typeof ctx.inject === 'function') {
        ctx.inject(['documentPreviews'], function (scoped) { mount(scoped) })
        return
      }
      mount(undefined)
    }

    exports.name = 'dsh-go-sensei'
    // 两个都是**软**依赖：缺席时各自静默降级，不做硬注入（否则整包永久 pending）。
    exports.inject = []
    exports.apply = function apply(ctx) {
      try {
        registerPanel(ctx)
      } catch (error) {
        // 面板注册失败绝不能影响插件其余部分（工具与服务端半照常工作）
      }
      try {
        registerDocumentPreview(ctx)
      } catch (error) {
        // 右侧栏预览注册失败同样不能影响面板与工具
      }
    }
    // 棋盘规则是纯函数，但只存在于这个单文件 bundle 里（浏览器半零构建、无模块系统），
    // 所以显式暴露给单测：React 桩只能验证"渲染出了什么"，验证不了提子算得对不对。
    // 生产路径不读它，宿主 Client 装载器也只认 name/inject/apply。
    exports.__internals = {
      boardLabel: boardLabel,
      parsePointLabel: parsePointLabel,
      groupAt: groupAt,
      playStone: playStone,
      boardAt: boardAt,
      starPoints: starPoints,
      pvGhostStones: pvGhostStones,
      baseName: baseName,
      filePathOfAddress: filePathOfAddress,
      sameFile: sameFile,
      renderBoard: renderBoard,
      // 棋手名条：与宿主 half 的 playerLabels 同一口径，单测直接钉死写法
      playerNameText: playerNameText,
      // 曲线图（三处视图共用）：单测直接渲染它，验证缺口断开、纵轴口径与点击定位
      renderCurve: renderCurve,
      curveDomain: curveDomain,
      curveValueText: curveValueText,
      curvesView: curvesView,
      focusPointer: focusPointer,
      // 两份 UI 的共享状态：单测直接摆好它再渲染整页棋盘
      //（React 桩把 useEffect 实现成空操作，所以发布/订阅在测试里不参与）
      senseiStore: senseiStore,
      senseiPatch: senseiPatch,
      // 整页排版（棋盘 / 曲线+列表 / 讲解 三块怎么摆）主要靠这些 CSS 规则，
      // 单测直接断言几条关键规则，免得以后重构时把「给讲解留位置」悄悄删掉
      CSS: CSS,
      PANEL_ID: PANEL_ID,
    }
    return module.exports
  },
})
