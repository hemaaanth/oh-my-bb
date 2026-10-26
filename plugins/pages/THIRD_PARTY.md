# Third-party components

## Highcharts 13.0.0

Pages bundles Highcharts in `assets/charts.js` (page charts), `assets/spec.js`
(components on pages), and `dist/app.js` (components in chat). It loads only
when a chart draws. Highcharts is not covered by the Pages MIT license.

Commercial use is governed by the Highsoft Standard License Agreement.
Non-commercial use is governed by the Highsoft End-User License Agreement.
Each user is responsible for obtaining and managing the Highcharts license
required for their intended use. Installing Pages does not grant a commercial
Highcharts license.

- License: https://www.highcharts.com/license
- Non-commercial EULA: https://www.highcharts.com/license-eula
- Copyright: Highsoft AS

The notice embedded in the installed npm package is reproduced in
`licenses/Highcharts.txt`.

## Inter

Pages includes the Inter variable font in `assets/inter.roman.var.woff2`.
Inter is Copyright 2016 The Inter Project Authors and is licensed under the
SIL Open Font License 1.1.

- Source: https://github.com/rsms/inter
- License: `licenses/Inter-OFL.txt`

## MingCute

Pages draws MingCute icons. The glyph paths are copied, with colours
removed, into `assets/icons.json` (icons on pages),
`app/spec/icons.generated.tsx` (chat components), and `assets/pages.svg`
(the canonical document mark used by BB's plugin surfaces). They come from the
`mingcute_icon` 2.9.72 npm package, by Richard9394 (MingCute Design), under
the Apache License 2.0.
The project has no NOTICE file.

- Source: https://github.com/Richard9394/MingCute
- License: `licenses/MingCute-Apache-2.0.txt`

## OpenUI

Pages renders ```` ```openui-lang ```` fences with `@openuidev/lang-core` and
`@openuidev/react-lang`, bundled in `dist/app.js` and `assets/spec.js`. The
Accordion behaviour in `app/spec/groups/layout.tsx` is ported from OpenUI
`react-ui`.
Copyright (c) 2011-2024 Thesys Inc. MIT License.

- Source: https://github.com/thesysdev/openui
- License: `licenses/OpenUI-MIT.txt`

## Generative UI (bb-plugin-genui)

Parts of the component logic are ported from Generative UI by ComicBit, under
the Apache License 2.0. Source headers mark the adapted parts. These include
`app/spec/groups/`, `app/spec/gpu/`, `app/spec/reports/`, viewer gesture
geometry, map tours, app documents and previews in `app/apps/`, source/excerpt
helpers, and `server/spec/` including credited Wikipedia-photo extraction.
The feature ports use upstream 0.3.1, commit
`c9700a34a9cc24961d17771590274e0703dc481c`.
The project has no NOTICE file.

- Source: https://github.com/ComicBit/bb-plugin-genui
- License: `licenses/GenUI-Apache-2.0.txt`

## Three.js

Scene rendering includes Three.js 0.186.1 and its GLTF/HDR loaders.
Copyright © 2010-2026 three.js authors. MIT License.

- Source: https://github.com/mrdoob/three.js
- License: `licenses/Three-MIT.txt`

## ShaderFrog GLSL Parser

Server-side shader checks use `@shaderfrog/glsl-parser` 7.0.1 and its generated
parser. The npm package credits Andrew Ray and declares ISC. Its npm archive
does not include a LICENSE file; `licenses/GLSL-parser-ISC.txt` records that
attribution and the standard ISC terms.

- Source: https://github.com/ShaderFrog/glsl-parser


## Board drag (bb-plugins)

`app/spec/groups/board-drag.ts` is adapted from `task-workspaces/task-drag.ts`
in bb-plugins. Copyright (c) 2026 Hemanth. MIT License.

- License: `licenses/bb-plugins-MIT.txt`

## Package dependencies

Other runtime and development dependencies are installed from npm and retain
the licenses declared by their respective packages. They are not relicensed by
Pages.
