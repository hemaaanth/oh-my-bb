# Third-party components and provenance

## Package grant and configured BB UI origin

`LICENSE` is an exact copy of the authorized repository-root MIT grant. It retains Hemanth's copyright and the Michael Yong / BB contributor notice. The manifest declares MIT for this package; it does not relicense dependencies.

`components.json` configures the public BB UI registry at:

```
https://raw.githubusercontent.com/get-bb/bb/desktop-v0.38.0/packages/plugin-registry/r/{name}.json
```

The local `components/` and `lib/` helpers use that configuration. The icon wrapper also records that it was trimmed from BB's vendored icon registry. These are the recorded provenance facts, not a claim that every local helper is an unchanged upstream copy. No upstream byte-for-byte registry audit was performed in this change. BB-derived portions retain the attribution in `LICENSE`.

## Icons

`components/ui/icon.tsx` imports ArrowDown01Icon, ArrowUp01Icon and Tick02Icon from `@hugeicons/core-free-icons`, and renders them through `@hugeicons/react`. The installed core package declares author Hugeicons and license MIT; it contains no separate license file. The React package supplies the Hugeicons copyright and MIT notice retained below. No independent per-glyph origin or clearance claim is made.

`icons/projects.svg` is the local folder-outline asset added by Projects 1P. It is distributed under this package's authorized MIT grant. No third-party icon origin or independent authorship claim is asserted for that SVG.

## Dependency metadata inspected

These are the versions and license declarations in the installed packages used for this release check, not new version pins. `package.json` and `package-lock.json` remain the dependency authority.

| Package | Inspected version | Declared license | Use |
| --- | --- | --- | --- |
| `@hugeicons/core-free-icons` | 4.3.0 | MIT | Runtime icon data |
| `@hugeicons/react` | 1.1.10 | MIT | Runtime icon renderer |
| `zod` | 4.6.7 | MIT | Runtime schemas |
| `@radix-ui/react-select` | 2.3.7 | MIT | Local Select component |
| `clsx` | 2.1.1 | MIT | Local class utility |
| `tailwind-merge` | 3.6.0 | MIT | Local class utility |
| `@get-bb/plugin-sdk` | 0.6.37 | Not declared in installed manifest | Public host API and development fixture |
| `@pierre/diffs` | 1.3.6 | Apache-2.0 | Development declaration |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Development declaration |
| `typescript` | 5.9.3 | Apache-2.0 | Build/typecheck tooling |

The remaining declared development packages were also inspected and declare MIT: the other `@radix-ui/react-*` entries, `@testing-library/react`, the four `@types/*` entries, `better-sqlite3`, `cron-parser`, `hono`, `jsdom`, `sonner`, `vaul` and `vitest`. Their exact names and versions are recorded in the lockfile. This inventory distinguishes metadata from a legal provenance audit. It does not claim that every development declaration is bundled into the output.

React and React DOM are public host interfaces. The installed React package supplies the Meta MIT notice below. The public Plugin SDK is supplied by BB at runtime; absence of a license field in its installed manifest is not replaced with an invented SDK license here. `node_modules` and development fixtures are not included in this package's npm archive. Separately installed packages retain their own license files and terms.

## Retained MIT notices

The following copyright notices come from the installed Zod, Hugeicons React, Radix Select, clsx, tailwind-merge and React license files. They share the MIT permission and disclaimer text reproduced below. The core-free-icons package's MIT metadata is recorded above; no missing copyright year is invented for it.

```
MIT License

Copyright (c) 2025 Colin McDonnell
Copyright (c) 2025 Hugeicons
Copyright (c) 2022 WorkOS
Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)
Copyright (c) 2021 Dany Castillo
Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
