# dsh-go-sensei —— DeepGo Sensei 围棋复盘教练

DSH（DeepSeek Harness）插件：把围棋 AI 的数学判断（胜率、目差、候选点、变化图）翻译成**老师级口头讲解**，供自学棋手复盘；讲解回写 SGF `C[]` 注释，[Lizzieyzy](https://github.com/yzyray/lizzieyzy) 原生可显示。

- 数据侧两条路径：① 消费你在 Lizzieyzy 中分析后保存的 SGF（实测支持其 `LZ`/`C[]` 分析格式）；② 配置 KataGo 后由插件经 `ctx.subprocess` 对关键手补算。
- 讲解与多轮追问由 DSH 会话原生完成（围棋老师人设段 + 5 个复盘工具）。
- 不修改 Lizzieyzy 源码、不用 Java、不直连 DeepSeek API（模型调用由 DSH agent loop 完成）。

## 安装

```bash
# 本地目录开发/试用
dsh plugin --profile web add ./dsh-go-sensei

# 发布后
dsh plugin --profile web add dsh-go-sensei
```

重启 `dsh web` 后生效。验证：

```bash
dsh --profile web --dump-config | grep -A2 go-sensei
```

Web 页面右下角出现「DeepGo Sensei · 复盘教练」浮动面板即客户端加载成功；卸载插件后面板与样式无残留。

## 配置（可选）

在 profile 的 `cordis.patch.yml`（或插件行）里覆盖：

```yaml
- id: go-sensei
  config:
    level: auto            # 18K..9D | auto（按棋谱双方段位自适应）
    winrateThreshold: 0.03 # 问题手胜率落差阈值（0~1）
    scoreThreshold: 3      # 问题手目差阈值（目）
    maxCandidates: 10      # 每次复盘返回的候选上限
    pvDepth: 6             # 变化图 PV 截断手数
    tokenBudget: 50000     # 单局讲解 token 预算（软约束）
    kataGoPath: C:\AI_GO-main\Lizzieyzy-KataGo-Portable_v1.1\engine_18b\katago.exe
    kataGoConfig: C:\AI_GO-main\Lizzieyzy-KataGo-Portable_v1.1\engine_18b\analysis_example.cfg
    kataGoModel: C:\AI_GO-main\Lizzieyzy-KataGo-Portable_v1.1\engine_18b\kata1-b18c384nbt-s9996604416-d4316597426.bin.gz
    maxVisits: 100         # KataGo 每手搜索量
```

`kataGoPath` 留空则不注册 `go_engine_analyze` 补算工具（纯消费 SGF 模式，零引擎依赖）。
注意：KataGo v1.14+ 的 analysis 模式使用 JSON 查询协议；GTP 配置文件（如 Lizzieyzy 的
`myconfig.cfg`）缺 analysis 键，建议直接指向引擎目录自带的 `analysis_example.cfg` 并单独给 `-model`。

## 使用流程（与 Lizzieyzy 配合）

1. 在 Lizzieyzy 里分析棋局，`保存` 时勾选保存分析数据（写入 `LZ[]` 与 `C[]` 注释），或直接把野狐/弈城导出的 SGF 放进工作区。
2. 对话里说「复盘这盘棋 <路径>」——插件自动：`go_parse_sgf` 读谱 → `go_review_moves` 找问题手 → 逐手讲解（先问后讲、水平自适应）。
3. 「把讲解写回棋谱」→ `go_write_review` 写入 `C[]` 注释 → Lizzieyzy 打开即可看到讲解。
4. 追问「第 N 手改下 X 会怎样」→ `go_position_context` 提供局面上下文与 AI 候选变化。
5. 「生成报告」→ `go_export_report` 落盘 Markdown（默认与棋谱同名 `.review.md`）。
6. 同一局重复复盘命中同局面哈希缓存（工具返回 `cached: true`，token 消耗显著下降）。

## 工具一览

| 工具 | 作用 |
|---|---|
| `go_parse_sgf` | 棋谱元信息 + 主变化线手数统计（GBK/双重 mojibake 自愈解码） |
| `go_review_moves` | 问题手候选（大恶手/失误/不精确 标签 + 胜率/目差损失 + ≤3 个 AI 候选点，PV 截断、1 位小数） |
| `go_position_context` | 某手前后 N 手序列 + 该手候选与 PV（供追问） |
| `go_write_review` | 讲解写回 SGF `C[]` 注释（默认追加、可覆盖、自动转义；按变化树定位主线，带变化图的棋谱同样可写） |
| `go_export_report` | Markdown 报告落盘（自动骨架或全文）。骨架 = 棋局信息 + 问题手表格 + **从 `C[]` 汇总已写回的逐手讲解**（自动剔除引擎分析行）；`format` 仅支持 `markdown`，其他值报错 |
| `go_engine_analyze` | （需 KataGo）对区间补算 kata-analyze，输出同构候选列表 |

无分析数据的棋谱自动降级 **theory 模式**：纯棋理讲解，不虚构胜率。

## 开发

```bash
npm install
npm test        # node:test 单测（含真实野狐/Lizzieyzy 棋谱夹具）
npm run check   # 语法检查（零构建，纯 JS）

# 无模型演示：对任意 SGF 跑 解析→复盘→写回（写 .demo.sgf 副本，不动原文件）
node scripts/demo.mjs <sgf路径> [起始手] [结束手]
```

`test/engine.test.mjs` 的真机 KataGo 集成测试在本机装有 KataGo 时自动运行（模型加载约 1~2 分钟），
无引擎环境自动跳过。

### 版本与发布

源码仓库：<https://github.com/Zhuang-A/dsh-go-sensei>（`main` 分支，语义化版本 tag）。

```bash
git clone git@github.com:Zhuang-A/dsh-go-sensei.git
cd dsh-go-sensei && npm install && npm test
```

- 改动直接提交到 `main`；发一版时同步改 `package.json` 的 `version` 并打同名 tag（如 `v0.1.0`），`git push --follow-tags`。
- 换行策略见 `.gitattributes`：源码统一 LF（不依赖各机器的 `core.autocrlf`）；`test/fixtures/*.sgf` 标 `-text`，按**字节原样**提交——真实野狐导出的夹具本身是 CRLF，一旦被 EOL 规范化改写，逐字节依赖夹具的解析测试就会失真。
- 不入库：`node_modules/`、`test/tmp-workspace/`、`*.tgz`、`*.demo.sgf`、`*.log`。

## 常见问题

- **面板没出现**：确认 `--dump-config` 里有 go-sensei 层，且重启过 `dsh web`；卸载插件需重启页面才消失。
- **野狐棋谱棋手名乱码**：文件是 GBK/双重 mojibake 编码，插件自动解码并在可无损回修时修复；个别字符已损坏时保留原文并给出 warning（不影响棋谱分析）。
- **Lizzieyzy 保存的 SGF 没有分析数据**：Lizzieyzy 需在保存时勾选「保存分析数据」（写入 `LZ[]`）；否则插件走纯棋理模式，或配置 KataGo 后用 `go_engine_analyze` 补算。
- **KataGo 报 `Could not find key`**：GTP 配置文件缺 analysis 键，改用 `analysis_example.cfg` 或加 `-override-config numAnalysisThreads=1`。
- **token 花费**：单局默认预算 5 万 token 软约束；数据裁剪（每手 ≤3 候选、PV 截断、1 位小数）+ 懒生成 + 同局面缓存；批量生成报告建议安排在 DeepSeek 闲时（高峰 9:00–12:00 / 14:00–18:00 涨价）。

## 已知限制与后续工作

- 面板入口在输入框下方一行（默认折叠）：展开后填 SGF 路径、点「读取问题手」即可。
- `go_write_review` 用 `@sabaki/sgf` 解析变化树定位主线后**重新序列化**输出：手数、旁支、属性集合与原有注释全部保留（实测 106 手 Lizzieyzy 分析谱写回后 106 手 / 2 个变化图不变），但**原文件的排版与逐字节格式不再保留**（输出统一 UTF-8，缩进规范化）。若需保留原始字节排版，请在写回前备份棋谱。
- 写入依赖 `ctx.sandboxPolicy` 解析出的 `SandboxExecutionPolicy`（作为 `fs.writeText` 第 5 参数）。该服务是**可选读取**，未挂载时不阻止加载，但沙箱后端下写入会被拒并给出 `file access denied` 警告。
- `go_engine_analyze` 目前仅 19 路；让子棋谱补算支持 2~9 子（标准摆点表）。
- KataGo 补算使用中国规则近似（`rules=chinese`）；贴目取自 SGF `KM[]`。
- `test/engine.test.mjs` 的真机集成测试需要能启动子进程：受限沙箱下 `spawnSync` 会返回 `EPERM`，测试会静默跳过（`KATAGO_PATH` 已设置也会跳过）。本机 KataGo v1.16.4 实测通过，单次补算约 3.8 秒。
- 报告骨架靠**整行模式匹配**区分"引擎分析行"与"人写的讲解"（判别式见 `extractUserNotes`）。若某种导出器的分析行格式不同，可能被当成讲解收进报告；宁可多留也不误删，导出后扫一眼即可。
- **Phase 4 客户端面板已实现**（`conversation.composer.dock`）：路径输入 → 问题手列表（第 N 手 / 黑白色 / 坐标 / 标签徽标 / 胜率差 / 目差 / AI 首选）→ **点任意一行把追问语真正插入输入框**。
  - 注册在 composer dock 而非 `shell.overlay`：只有 `conversation.composer.*` 系列的标准 props 提供 `inputActions`（`shell.overlay` 只给 `useSessions`/`usePanelInfo` 等），而插入输入框必须用它。
  - 数据来自 Host 路由 `GET /go-sensei/review?path=<sgf>&cwd=<工作区>`（同源 fetch）。绕服务端的原因：客户端插件**拿不到工具的 execute**（Host 工具面只暴露 `register`/`schemas`/`get`），也无法直接读盘；由拥有 `ctx.fs` 与 `reviewGame` 的宿主读盘算好、回裁剪后的 JSON。该路由只读无副作用，`cwd` 由面板从会话快照带出以解析相对路径。
  - 面板是**软依赖**组合：React 或 `slots` 缺席时静默不注册（`inject: []`），绝不因面板问题拖垮工具与服务端半。

### 工具 schema 子集（改 schema 前务必读）

`ctx.tools.register` 会对 `parameters` 与 `output.schema` 跑 `@deepseek-ai/dsh-tools` 的
`assertSupportedJsonSchema`；**不通过就抛错、插件加载中止，`dsh web` 直接起不来**。支持的关键字只有：

`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` + 注解类（`description` / `title` / `default` / `examples`）。

三条实测踩过的坑：

1. **`type` 必须是单一类型字符串**，不接受数组。写 `type: ['object','null']` 会报
   `UNSUPPORTED_SCHEMA`（本插件确实由此导致过一次启动失败）。可选字段请**省略该键**而不是给 `null`。
2. 除上述白名单外的任何关键字都会被拒（如 `pattern` / `minimum` / `format`）。
3. `type` 与 `oneOf` 不能同时出现；`oneOf` 至少要两项。

`test/schema.test.mjs` 直接 import 运行时校验器，对**每个工具的 parameters 与 output.schema**
逐条断言，并显式禁止 `type` 数组——改 schema 后跑 `npm test` 即可拦住这类启动级故障。

## 许可

MIT。与 Lizzieyzy（GPL-3.0）仅经 SGF 文件交互，不链接、不合并其代码。
