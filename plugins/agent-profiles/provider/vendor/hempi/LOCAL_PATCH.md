# Agents local prompt wording patch

`REVISION` is the unchanged upstream base `2db99a3ab1175723d022a4a348350be74fbe9824`. This directory is not a byte-exact copy of that base.

## Local changes

- `src/optchat/prompts.ts`: original concise wording replaces the attributed core prompts `COMPACT`, `MASTER`, `VIEW_DOC`, `SUBAGENT`, and the compaction/retry task text. The related call-context explanation and internal `allowSearch` markers change with that wording.
- Export names, signatures, supplied node/message/call IDs, `<chat>`, `<input>`, `<call>`, the row format, the byte ruler, and the retry limit marker remain compatible.
- The replacement is derived from `memory.ts`, `tools.ts`, `compactor.ts`, and the actual main/child consumer contracts. It is not a copy, paraphrase, or synonym rewrite of the excluded attributed prompt expression.
- Existing import, continuity, restart, connected/delegation, status, and handoff adapters remain unchanged. No store, memory algorithm, schema, model route, capability, or turn/cancellation contract changes.
- `NOTICE.md` gains a local distribution clarification. `LICENSE` records the accepted owner MIT grant for owned Hempi code. Upstream implementation grants, exclusions and credits are retained separately.

Original prompt-file SHA256 at the retained base:
`4890fbced64d75ac72952fee8cb33e6a1ee48e1b98479a9bde280e7901ab20d6`

Patched prompt-file SHA256:
`f7b5057916b06bdc6facc8eb20866f5823cdbc7544bea336e79feec9a349c565`

The old wording remains only in retained private history/proof. It must not be restored into distributed source or embedded artifacts. Publish a reviewed current-tree snapshot, not the retained private history containing the removed text.

## Regeneration

After reviewing a local source change, run `node scripts/refresh-hempi.mjs --local` from the Agents package. This explicit mode reads only the retained vendor tree and its base revision. It accepts no source checkout or revision argument and has no checkout/network fallback. Then run `node scripts/refresh-hempi.mjs --check`.

`HEMPI_COMMIT` identifies the upstream base. `HEMPI_SOURCE_SHA256` identifies the exact local source payload, including this record. Runtime materialization already uses both identities, so a patched payload does not reuse the old cache directory. Do not invoke the upstream archive-refresh mode for this patch.

## Rights boundary

The memory design retains its attribution to Victor Taelin. The upstream OMP and OptChat implementation notices remain in place. Their grants do not relicense excluded attributed prompt text. The owner confirms Hempi is their own app and authorizes public MIT publication of owned code, recorded in `LICENSE`. This does not relicense excluded upstream expression or third-party dependencies. Wider native/runtime acceptance remains separate.

Offline consumer checks cover protocol behavior only. They do not certify real model summary quality.
