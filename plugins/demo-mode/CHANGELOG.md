# Changelog

## 0.1.1

- Show the marketplace screenshot in the GitHub README.
- Mask workflow titles, phase and agent names, queue previews, and wait details. Keep progress counts visible.
- Hide browser-rendered list markers without changing list layout. Leave BB's native plugin catalog uncovered.

## 0.1.0

- Add the Demo Mode sidebar footer action and the `Mod+Shift+D` command `plugin:demo-mode/toggle`.
- Mask each word of thread and project names, headers, messages, tool steps, status lines, running commands, the uncommitted-files banner, and drafts with same-length CSS highlight blocks. Layout does not move.
- Replace names in titles and labels with "Demo item". Fill images. Keep sidebar structure, counts, statuses, and the AI model visible.
- Cover plugin pages unless they mark their own sensitive parts with `data-bb-demo-ready` and `data-bb-demo-sensitive`.
