# INDEX.md · 围棋讲解技能族总览

## 一、本册产出
| 件 | 路径 | 作用 |
|---|---|---|
| 技能正本 | `skills/go-detailed-explanation/SKILL.md` | 讲一手棋的完整判据与流程（R/I/A1/A1b/A2/E/B ＋ CHECKPOINT ＋ 输出结构） |
| 盘面锚索引 | `skills/go-detailed-explanation/ANCHORS.md` | 89 条可回放案例锚（自动生成，勿手改） |
| 盘面锚数据 | `skills/go-detailed-explanation/ANCHORS.jsonl` | 机器数据：每条含现成的一行 SGF（`sgf` 字段），落盘即可交 go_draw_diagram |
| 术语表 | `skills/GLOSSARY.md` | 讲棋统一用词，每条带池 id 与页锚 |
| 本索引 | `skills/INDEX.md` | 技能总览、引用图、交叉引用约定 |
| 精华长文 | `DIGEST.md`（阶段5） | 给读者看的长文版 |
| 门禁记录 | `gates-go-detailed-explanation.json`（阶段5） | 三闸判态留痕 |

技能族当下**只有一个技能**（`go-detailed-explanation`）。原书候选池 206 条全部指向同一个技能族 S1，不需要拆分成多个技能；拆分点若日后出现（例如把「死活」「官子」单独拆出），按本索引的交叉引用约定追加。

## 二、引用图（本技能的上下游）
```
用户提问
  ├── 要棋理 / 定性 / 改法 ──→ go-detailed-explanation（本技能）
  │        └── 需要配图 ──→ go_draw_diagram（运行时工具，非本库技能）
  └── 要数值 / 形势 / 搜索结论 ──→ go_review_moves / go_position_context /
                                   go_engine_analyze / go_draw_diagram
（本技能不调用、不包含上述工具，只在 B2 里声明让位）
```
注：`go_*` 是 DSH 的围棋复盘工具族（插件提供），不是本技能库里的技能，因此**不写进 frontmatter 的 `related_skills`**（写了会被判为死链 slug）。

## 三、交叉引用约定
1. **池 id 形如 `VA-001`**：字母段为簇（A–I），数字段为条目序；池 id 只在 SKILL.md、GLOSSARY.md、INDEX.md 三个文件之间互引，权威定义在 `verified.md`。
2. **页锚形如 `《书名》〔pN〕`**：书名三选一——《围棋正招与俗手》《常用术语格言图解》《围棋俗筋剖析》；页号是**该 PDF 的页序**，不是印刷页码；机器核验用的是 `parts/<id>.md` 里的 `===== [PAGE N] =====` 标记。
3. **逐字引文只允许在 SKILL.md 的 `## R 原文锚` 段出现**。其他文件（含本索引与 GLOSSARY）只写转述 ＋ 池 id；需要引文时指向 R 段，不在别处重打一遍，避免重打时引入形近字污染。
4. **新增簇**：若补新书，簇字母续编（J、K…），先追加到 `verified.md`，再在 SKILL.md 的 R 段加同编号小节，最后同步本索引。
5. **运行时数值不进技能文件**：胜率、目差、归属图一律运行时由引擎取；技能文件里出现任何具体数字都视为过期风险。
6. **盘面锚 id 形如 `SG-001`**：独立命名空间，**不属于** V 池，权威定义在 `ANCHORS.jsonl`（由 `source-survey/gen-anchors.mjs` 生成）。只在 SKILL.md 的 `## A1b` 与 `ANCHORS.md` 出现，不进 `verified.md`、不改候选池；核验走 `tools/go-verify-anchors.mjs`（自洽五项 ＋ 逐字回源）。**随件必须扁平**——插件的 `src/skill-install.js:113` 拒绝含子目录的随件，所以 89 个盘面存成 `ANCHORS.jsonl` 的 `sgf` 字段，不落成 89 个 `.sgf` 文件。

## 四、溯源链
```
ebook/围棋电子书/              原始 PDF（只读，未改动）
  └─ parts/<id>/pNNNN.txt      OCR 逐页文本（页锚 = 文件名）
      └─ parts/<id>.md         机器可核原文包（===== [PAGE N] ===== 标记）
          └─ notes/notes_band{1..4}.md   提取笔记（206 条，逐字引文）
              └─ verified.md             去重合并（136 条，109 条逐字引文）
                  └─ skills/go-detailed-explanation/SKILL.md   R 段引文 + 判据表

ebook/围棋电子书/              自带讲解的 SGF（三套，解压用 Windows tar.exe）
  └─ source-survey/sgf/        解包后的 188 个 SGF（GBK）
      └─ source-survey/anchors.jsonl      840 个图单元 + 锚验证（逐图择优编号约定）
          └─ source-survey/anchors-curated.jsonl  策展 89 条
              └─ skills/go-detailed-explanation/ANCHORS.jsonl + ANCHORS.md  89 条可回放锚（扁平随件）
```
核验命令：
- `node tools/go-verify-notes.mjs books/go-detailed-explanation` —— 引文回源核验（当前 206/206 命中）。
- `node tools/go-check-skill-refs.mjs books/go-detailed-explanation` —— 技能文件池 id 实存核验 ＋ R 段引文与 verified.md 的逐字一致性核验。
- `node tools/go-verify-anchors.mjs <技能目录> --source <sgf 根>` —— 盘面锚自洽五项 ＋ 逐字回源（当前 89/89）。