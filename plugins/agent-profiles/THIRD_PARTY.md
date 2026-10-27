# Third-party provenance and release gates

## License scope

The root [MIT license](LICENSE) is the accepted grant for Agents owner code and attributed BB portions. It is not a blanket grant over every embedded dependency. The retained provider copy keeps its original [MIT permission](provider/LICENSE) and [provenance](provider/NOTICE).

**The Hempi owner-code grant is resolved.** The owner confirms Hempi is their own app and authorizes public MIT publication. The accepted grant is retained in [the Hempi LICENSE](provider/vendor/hempi/LICENSE) for owned implementation and original local wording. It does not relicense excluded upstream prompt expression or third-party dependencies.

## BB public SDK/runtime

The development declaration remains `@get-bb/plugin-sdk` 0.6.37. Actual build metadata records BB 0.46.1 with SDK 0.6.49. Native BB supplies the public SDK runtime and frontend shims; the emitted server also imports the public SDK. The host/server artifacts contain public SDK helper code. Do not confuse the declaration pin with the builder/runtime version.

The public [npm 0.6.49 metadata](https://registry.npmjs.org/@get-bb%2fplugin-sdk/0.6.49) identifies git head `05771e3c82404328854468f0fff7f0f8203e2076` and `get-bb/bb`'s `packages/plugin-sdk`. That exact commit's [root LICENSE](https://raw.githubusercontent.com/get-bb/bb/05771e3c82404328854468f0fff7f0f8203e2076/LICENSE) is MIT, copyright 2026 Michael Yong. Its SDK directory has no separate license override. This is upstream SDK permission evidence, not the new Agents owner grant. The full upstream text is preserved in [received notices](THIRD_PARTY_LICENSES.txt).

That grant does not relicense SDK dependencies. Received cross-spawn, isexe, path-key, shebang-command, shebang-regex and which notices are separately preserved. Actual emitted maps identify these helper modules. Their presence is not a runtime dependency on another BB plugin.

## Own locked libraries

| Component | Own lock version | Received evidence / use |
| --- | --- | --- |
| `@hugeicons/core-free-icons` | 4.2.3 | Package metadata declares MIT; free icon data only. No separate LICENSE or copyright line was received. This remains metadata-only evidence. |
| `@hugeicons/react` | 1.1.9 | MIT, copyright 2025 Hugeicons; received `LICENSE.md`. No Pro icon set is used or licensed by this record. |
| `@radix-ui/react-slot` | 1.3.3 | MIT, copyright 2022 WorkOS; received LICENSE. |
| `@radix-ui/react-compose-refs` | 1.1.5 | Received MIT LICENSE. |
| `@radix-ui/react-use-layout-effect` | 1.1.4 | Received MIT LICENSE; native UI dependency provenance. |
| `emoji-picker-react` | 4.22.2 | MIT, copyright 2022 ealush. The server uses its local emoji dataset, not an image CDN. |
| `shipstyles` | 1.0.0 | Received MIT LICENSE, copyright 2024 ealush; transitive emoji-picker-react dependency. |
| `zod` | 4.6.7 | MIT, copyright 2025 Colin McDonnell; validation and UI draft parsing. |

[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) preserves the received full permission texts. Identical texts are grouped without inventing new copyright lines. Hugeicons core's missing standalone notice is not filled from its React adapter or Pro license. The native frontend's React/BB UI shims belong to the separately provided BB runtime. Source build/test tools remain development dependencies with their own package licenses.

Branding emoji SVGs contain original markup and Unicode characters rendered by system fonts. They do not embed font files, commercial icon outlines or rendered font glyph images.

The actual cold build emits Tailwind CSS 4.3.0's MIT banner. Its [npm metadata](https://registry.npmjs.org/tailwindcss/4.3.0) and exact [upstream v4.3.0 license](https://raw.githubusercontent.com/tailwindlabs/tailwindcss/v4.3.0/LICENSE) identify the generated stylesheet's permission notice. The full Tailwind Labs text is also retained in `THIRD_PARTY_LICENSES.txt`. This is a BB-provided build toolchain, not a new plugin runtime import.

## Retained Hempi implementation and local patch

The unchanged upstream base is `2db99a3ab1175723d022a4a348350be74fbe9824`. It is not a claim that the current vendor tree is byte-exact upstream. [LOCAL_PATCH.md](provider/vendor/hempi/LOCAL_PATCH.md) records the original core prompt replacement. `HEMPI_SOURCE_SHA256` records exact local payload bytes and participates in runtime cache identity.

Keep these separate upstream records:

- [OMP-LICENSE](provider/vendor/hempi/OMP-LICENSE): MIT implementation notice, with Mario Zechner, Can Bölük and Stencil Labs credits.
- [OPTCHAT-LICENSE](provider/vendor/hempi/OPTCHAT-LICENSE): MIT implementation notice for Jonas Silva's covered work. Its explicit exclusions remain unchanged. It does not grant the excluded attributed prompt expression or bundled third-party dependencies.
- [NOTICE.md](provider/vendor/hempi/NOTICE.md): retained implementation/design attribution and the local distribution clarification.

The attributed core runtime expression was replaced with genuinely original contract-derived wording. Existing implementation/design credits remain. No upstream/private Hempi refresh or base-pin change occurred. Only explicit local regeneration was used. Offline protocol checks do not certify real model quality.

The old wording remains in private recovery/history artifacts. It must not appear in a public source tree, generated artifact, diff bundle or published Git history. Publish only an approved current-tree snapshot. Do not publish private proof fixtures.

## Remaining decisions

The owner authorizes MIT publication of owned Agents/Hempi code. Separate upstream grants and exclusions remain authoritative. Hugeicons core evidence remains labelled metadata-only. Native runtime, installed extension provenance, full-shell UX and later preparation/consumer acceptance remain separate. This checkpoint performs no live install, provider request, source switch or publication.
