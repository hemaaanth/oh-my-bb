# Third-party components

## BB shared UI

`app/components/ui/` and `app/lib/` come from the BB plugin registry (`@bb` in
`components.json`, pinned to `desktop-v0.46.1`), MIT, added with
`npx shadcn add`. The registry writes to the package root and ignores the
`components.json` aliases, so the files were moved under `app/` afterwards.
Their imports are relative, so the move changes no code. Rerun the command and
move the files again to update them.

## Pet face

The pet draws its face with [`agent-robot-avatar`](https://www.npmjs.com/package/agent-robot-avatar)
0.5.2, MIT.

## Dispatch icon

`icons/dispatch.svg` is original to this package.
