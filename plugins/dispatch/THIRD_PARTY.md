# Third-party components

## Bundled packages

The build bundles these packages into `dist/`. Each keeps its own license.

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| [`agent-robot-avatar`](https://www.npmjs.com/package/agent-robot-avatar) | 0.5.2 | MIT, © 2026 CX ART Lab | The pet's face. |
| [`react-colorful`](https://www.npmjs.com/package/react-colorful) | 5.8.1 | MIT, © 2020-present Vlad Shilov | Visual colour selection, including keyboard and touch controls. |
| `@radix-ui/react-slot` | 1.5.0 | MIT | The shared UI button. |
| `@radix-ui/react-checkbox` | 1.3.3 | MIT | The plugin access checklist. |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Shared UI variants. |
| `clsx` | 2.1.1 | MIT | Class names. |
| `tailwind-merge` | 3.7.0 | MIT | Class names. |
| `zod` | 4.6.7 | MIT | Checking setup values and RPC data. |

React, the BB plugin SDK, and `better-sqlite3` come from the BB host. They are
not bundled. `@radix-ui/react-select` and `@radix-ui/react-popover` (MIT) are
runtime-shimmed to BB's copies, so their popups share the host's focus and
overlay handling. `bb plugin types` keeps their type-only dependencies aligned.

## BB shared UI

`app/components/ui/` and `app/lib/` come from the BB plugin registry (`@bb` in
`components.json`, pinned to `desktop-v0.46.1`), MIT, added with
`npx shadcn add`. The registry writes to the package root and ignores the
`components.json` aliases, so the files were moved under `app/` afterwards.
Their imports are relative, so the move changes no code. Rerun the command and
move the files again to update them.

The settings select and checkbox were copied from the owner's Catalog plugin's
vendored BB UI kit on 2026-10-19. They reuse the existing class-name utility and
plugin portal-scope helper. `icon.tsx` forwards to the SDK's host icon component;
it does not bundle the older kit's Hugeicons library.

## Owner-authored files

These files come from the owner's earlier voice plugin work, © 2026 Hemanth
Soni, MIT. They were copied with new names, new imports, and new comments.

| File | What it does |
| --- | --- |
| `app/pointer-ghost/model.ts`, `overlay.tsx`, `model.test.ts` | The pointer ghost. |
| `app/pet/pet.tsx`, `pet.test.tsx` | The footer pet and call disclosure. |
| `app/pet/mood.ts`, `mood.test.ts` | The pet's mood from call state and tool calls. |
| `app/pet/look.ts` | The look normaliser and type. The storage half was dropped. |
| `voice/chimes.ts` | Start and stop sounds. |
| `voice/draft.ts`, `draft.test.ts` | Composer draft edits for the two composer tools. |
| `server/telephony.ts`, `telephony.test.ts` | The phone call path through Twilio and OpenAI SIP. |
| `docs/phone-calls.md` | The phone call guide. |

`app/phone-dial.ts` was rewritten for this package, not copied.

## Dispatch icon

`icons/dispatch.svg` is original to this package.

## react-colorful license

```text
MIT License

Copyright (c) 2020-present Vlad Shilov <omgovich@ya.ru>

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
