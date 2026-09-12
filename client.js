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
    ].join('\n')

    /** 注入样式（幂等；只插一次，避免重复注册时堆积）。 */
    function ensureStyles() {
      try {
        if (document.getElementById(STYLE_ID) !== null) return
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      } catch (error) {
        // 非浏览器环境（测试桩）忽略
      }
    }

    /** 按标签上色：大恶手→error、失误→warn、其余→次要色。 */
    function severityColor(label) {
      var text = String(label == null ? '' : label)
      if (text.indexOf('大恶手') >= 0) return 'var(--dsw-alias-state-error-primary, #e5534b)'
      if (text.indexOf('失误') >= 0) return 'var(--dsw-alias-state-warn-primary, #d29922)'
      return 'var(--dsw-alias-label-secondary, #9aa4b2)'
    }

    /** 由服务端读取到的候选，拼出可直接发送的追问语。 */
    function followUpText(candidate, path) {
      var where = candidate.coordLabel ? '（这手下在 ' + candidate.coordLabel + '）' : ''
      var suggest = candidate.pv && candidate.pv[0] && candidate.pv[0].label
        ? '，AI 推荐 ' + candidate.pv[0].label
        : ''
      return '追问：第 ' + candidate.moveNumber + ' 手' + where + suggest
        + '，这手为什么不好？改下哪里会更好？请结合局面与候选变化讲解。'
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
     * 复盘入口（composer dock）。展开后：路径输入 + 读取 + 问题手列表。
     * props.inputActions.setDraft 是「真正把文字写进输入框」的动词。
     */
    function SenseiPanel(props) {
      var actions = props && props.inputActions ? props.inputActions : noActions()
      var state = React.useState('')
      var path = state[0]
      var setPath = state[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var dataState = React.useState(null)
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
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      // 会话工作区根：客户端快照里没有 cwd 字段，这里只作「锦上添花」尝试；
      // 真正可靠的基准由 Host 用 tools/result 记下的工作区根提供。
      var cwd = ''
      try {
        var snapshot = props && typeof props.useSession === 'function'
          ? props.useSession(function (s) { return s })
          : null
        if (snapshot && snapshot.header && snapshot.header.cwd) cwd = String(snapshot.header.cwd)
      } catch (error) {
        cwd = ''
      }

      function load() {
        var target = String(path || '').trim()
        if (target === '') { setErr('请先填写 SGF 路径'); return }
        setBusy(true); setErr(''); setNotice(''); setHint('')
        var url = '/go-sensei/review?path=' + encodeURIComponent(target)
          + (cwd ? '&cwd=' + encodeURIComponent(cwd) : '')
        fetch(url)
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            setBusy(false)
            if (body && body.ok === true) { setData(body.data) }
            else {
              setData(null)
              setErr(body && body.error ? String(body.error) : '读取失败')
              if (body && body.hint) setHint(String(body.hint))
            }
          })
          .catch(function (error) {
            setBusy(false); setData(null); setErr(String(error && error.message ? error.message : error))
          })
      }

      function insert(text) {
        actions.setDraft(text)
        setNotice('已插入输入框，回车即可发送')
      }

      var head = React.createElement('div', { className: 'dgs-head' },
        React.createElement('span', { className: 'dgs-title' }, 'DeepGo Sensei'),
        React.createElement('span', { className: 'dgs-sub' }, '点位复盘 · 点击问题手即插入追问'),
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

      if (data) {
        var list = Array.isArray(data.candidates) ? data.candidates : []
        kids.push(React.createElement('div', { className: 'dgs-sub', key: 'meta' },
          (data.mode === 'analysis' ? 'AI 分析' : '纯棋理') + ' · 难度 ' + String(data.level || '-')
          + ' · ' + String(data.moveCount || 0) + ' 手 / ' + String(data.variations || 0) + ' 变化图'
          + ' · ' + list.length + ' 个问题手'))
        if (list.length === 0) {
          kids.push(React.createElement('div', { className: 'dgs-sub', key: 'none' }, '未发现明显问题手（或棋谱无分析数据）'))
        } else {
          kids.push(React.createElement('div', { className: 'dgs-list', key: 'list' },
            list.map(function (candidate, index) {
              var top = candidate.pv && candidate.pv[0] ? candidate.pv[0] : null
              return React.createElement('button', {
                className: 'dgs-item',
                key: String(candidate.moveNumber) + '-' + index,
                title: '点击把追问语插入输入框',
                onClick: function () { insert(followUpText(candidate, data.path)) },
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
                  + (candidate.scoreLoss == null ? '' : ' / ' + candidate.scoreLoss + ' 目')
                  + (top && top.label ? ' · AI 首选：' + top.label : '')),
              )
            }),
          ))
        }
      }

      return React.createElement('div', { 'data-dgs': '' }, head,
        React.createElement('div', null, kids))
    }

    /** 注册到 composer dock；React/slots 缺席时静默跳过。 */
    function registerPanel(ctx) {
      if (React === null || typeof React.createElement !== 'function') return
      var slots = ctx.get('slots')
      if (slots === undefined || typeof slots.inject !== 'function') return
      ensureStyles()
      slots.inject('conversation.composer.dock', function () {
        return slots.register(
          { name: 'conversation.composer.dock', id: 'go-sensei-panel' },
          SenseiPanel,
        )
      })
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
    }
    return module.exports
  },
})
