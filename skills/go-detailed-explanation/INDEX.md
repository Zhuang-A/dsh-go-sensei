# INDEX.md · 围棋讲解技能族总览

## 一、本册产出
| 件 | 路径 | 作用 |
|---|---|---|
| 技能正本 | `skills/go-detailed-explanation/SKILL.md` | 讲一手棋的完整判据与流程（R/I/A1/A2/E/B ＋ CHECKPOINT ＋ 输出结构） |
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

## 四、溯源链
```
ebook/围棋电子书/              原始 PDF（只读，未改动）
  └─ parts/<id>/pNNNN.txt      OCR 逐页文本（页锚 = 文件名）
      └─ parts/<id>.md         机器可核原文包（===== [PAGE N] ===== 标记）
          └─ notes/notes_band{1..4}.md   提取笔记（206 条，逐字引文）
              └─ verified.md             去重合并（136 条，109 条逐字引文）
                  └─ skills/go-detailed-explanation/SKILL.md   R 段引文 + 判据表
```
核验命令：
- `node tools/go-verify-notes.mjs books/go-detailed-explanation` —— 引文回源核验（当前 206/206 命中）。
- `node tools/go-check-skill-refs.mjs books/go-detailed-explanation` —— 技能文件池 id 实存核验 ＋ R 段引文与 verified.md 的逐字一致性核验。
