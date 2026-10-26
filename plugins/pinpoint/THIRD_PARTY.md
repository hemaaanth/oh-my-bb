# Third-party notices

## BB shared UI and shadcn/ui

Vendored controls under `components/ui/` and `lib/utils.ts` originate from the [BB plugin registry](https://github.com/get-bb/bb/tree/desktop-v0.38.0/packages/plugin-registry) and shadcn/ui under the MIT license. `components.json` records the registry source. The responsive dialog, portal scope, and overlay scrollbar follow the accepted public package pattern. The unused browser-dimming hook was not copied.

Copyright (c) BB contributors
Copyright (c) 2023 shadcn

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

## Dependencies

Hugeicons, Radix UI, snapDOM, Zod, and other dependencies retain the licenses distributed in their npm packages. Package-local dependencies and versions are recorded in `package-lock.json`. The static Pinpoint target SVG is original simple circle geometry. React, BB's frontend SDK, and host-shimmed UI packages use the installed BB runtime in managed plugin builds. The optional standalone review client bundles its own frontend runtime and third-party notices remain in the generated JavaScript.

The Clasi validation and repository-scope algorithms are package-local copies of the MIT-licensed public Clasi contract. Pinpoint has no sibling runtime import or required Clasi installation.
