# Agent integration and retrieval roadmap

This note records the evidence behind Graft's lightweight multi-host policy and
the next accuracy work. It separates **context delivery** from **retrieval
ranking**: progressive disclosure and hook cleanup are low-risk and directly
measurable; ranking changes should pass a benchmark before shipping.

## Multi-host context policy

Modern coding agents increasingly support Agent Skills / progressive disclosure.
Graft is specialized repository-navigation guidance, so its full workflow should
not occupy every prompt.

- Claude Code: project `.claude/skills/graft/SKILL.md`.
- Codex + OpenCode: shared project `.agents/skills/graft/SKILL.md`.
- Cursor: the same `.agents/skills` skill; the old rule is a small non-always-on compatibility pointer.
- Gemini CLI: shared `.agents/skills` skill; `GEMINI.md` keeps only a tiny pointer.
- GitHub Copilot: shared `.agents/skills` skill; repository custom instructions keep only a tiny pointer.
- Kiro: `.kiro/skills/graft/SKILL.md`; old steering is manual-only.
- Windsurf/Cascade: native `.windsurf/rules/graft.md` with `trigger: model_decision`; only its description is persistent and the full body loads when relevant.
- Grok and AdaL: their existing native skill paths.
- Hermes: user skill store `~/.hermes/skills/graft/SKILL.md`.
- Google Antigravity: existing global Gemini skill; bare `.agents/` is not proof
  Antigravity is installed because that directory is a cross-agent standard.

Hooks exist only where they improve freshness, not to inject context or collect
usage accounting. Claude, Codex, and Cursor use edit + turn-end sync. Other hosts
rely on query-time freshness.

A globally registered MCP server injects no Graft instruction block in a repo
with no Graft graph, so machine-wide MCP fallback does not spend Graft context in
unrelated repositories.

## Evidence for progressive disclosure

- Gemini CLI Agent Skills: metadata first, full body only when activated.
  https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md
- Cursor Agent Skills: progressive, with `.agents/skills` and `.cursor/skills`
  project sources.
  https://cursor.com/docs/skills
- GitHub Copilot: skills load when relevant; detailed task-specific guidance
  belongs in skills rather than always-on instructions.
  https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills
- Kiro: skills use discovery -> activation -> execution progressive disclosure.
  https://kiro.dev/docs/skills/
- OpenCode: skill bodies load on demand and `.agents/skills` is a supported
  project source.
  https://opencode.ai/docs/skills
- Hermes: full skill content is loaded only when needed.
  https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- Cursor hooks: `afterFileEdit` and `stop` are native agent hooks and work in
  cloud agents; they are enough for edit freshness + one end-of-turn sync.
  https://cursor.com/docs/hooks

## Why on-demand ("pull") is also an accuracy choice

Upstream Graft's current README reports its own agent harness with equal
correctness for cold versus pushed Graft context (93%/93%), while the pull
variant — Graft tools available but context requested on demand — reached 98%
correctness. Treat this as upstream's self-reported harness rather than an
independent benchmark, but it supports the same design direction as skills:
make strong structural context easy to pull without forcing it into every turn.

https://github.com/trailhq/Graft/blob/main/README.md

## Retrieval accuracy: measure before changing ranking

Agent Retrieval Bench (2026) contains 427 workflow-derived samples across 25
repositories. No retrieval family wins every task; RepoMap is strongest on
budgeted context yield at 8K tokens while embedding, lexical, and structural
methods lead different objectives. Simple top-score thresholds do not solve
selective abstention on natural no-gold cases.

- https://agent-retrieval-bench.github.io/
- https://arxiv.org/abs/2607.24882

A third-party measurement in upstream Graft issue #117 reports that, on 186
merged PRs across four repositories, Graft 0.10.1 `ask` trailed a raw-file BM25
baseline and sometimes missed files one graph edge away. Treat these as the
issue author's measurements, not canonical benchmark results. Current Graft has
since changed its ranking stack, so reproduce the failure on the current fork
before changing production ranking.

- https://github.com/trailhq/Graft/issues/117

Repository-code RAG research also finds that contextual code and API information
help while superficially similar code can add noise. CodeRAG reports gains from
multi-path retrieval, query construction, and preference-aligned reranking.

- https://arxiv.org/abs/2503.20589
- https://aclanthology.org/2025.emnlp-main.1187/

## Proposed accuracy work

1. **Add a retrieval benchmark gate.** Measure MRR, Recall@k, distinct-file
   recall, budgeted context yield, latency, exploration steps, and output/input
   tokens across code2test, trace2code, edit2ripple, and comment2context tasks.
2. **Reproduce issue #117 on current Graft.** Do not assume measurements from
   0.10.1 still describe the current file-first + graph-ranked implementation.
3. **Benchmark whole-file lexical retrieval at the file stage.** A cheap
   raw-file BM25/lexical candidate source is a useful complement and a strong
   baseline; compare it against current symbol/body retrieval rather than
   replacing current ranking by assumption. Upstream issue #257 is already
   exploring this exact file-first direction and reports that naive/strong
   one-hop propagation can regress some repositories, which reinforces the need
   for relation-aware, budgeted evaluation rather than a blanket graph boost.
   https://github.com/trailhq/Graft/issues/257
4. **Evaluate bounded one-hop expansion.** Expand only high-confidence seeds,
   weight relation kinds separately, and enforce strict file/token budgets.
   Compare imports/references/calls independently; never flood the candidate set.
5. **Evaluate hybrid file retrieval.** Fuse lexical/file evidence, structural
   graph evidence, and compact API/skeleton evidence before span projection.
6. **Prefer API/type/interface evidence over similar-code noise** for
   implementation tasks where likely callable surfaces are more useful than
   semantically similar snippets.
7. **Expose edge provenance for high-risk work.** Distinguish compiler/LSP-backed
   edges from inferred/name-derived relationships so agents can choose or verify
   authoritative references.
8. **Treat confidence as descriptive, not absolute.** Keep coverage/evidence
   signals, but avoid a universal no-result threshold until abstention calibrates
   across repositories and workflow types.
9. **Measure end-to-end agent behavior.** A retrieval change ships only if it
   improves file discovery or task success without exceeding explicit context,
   exploration-step, or latency budgets.

## Token-efficiency metrics that matter

Do not use estimated "tokens saved" as the primary success metric. Measure:

- always-loaded instruction bytes/tokens by host;
- skill metadata bytes versus activated skill-body bytes;
- MCP schema + initialize-instruction tokens in built and unbuilt repositories;
- Graft result tokens per useful/gold file retrieved;
- total model input tokens until the first correct edit;
- number of exploratory reads/searches before the first correct edit;
- task success and regression rate at a fixed context budget.

## Non-goals

- No mandatory Graft-first behavior.
- No embeddings, query rewriting, graph expansion, or rerankers enabled by
  default without benchmark wins on Graft's actual workload.
- No source-verification weakening: Graft remains navigation evidence, not truth.
