# Third-party notices

## BB shared UI and shadcn/ui

The vendored controls under `components/ui/`, `lib/utils.ts`, and `lib/portal-scope.ts` originate from the [BB plugin registry](https://github.com/get-bb/bb/tree/desktop-v0.38.0/packages/plugin-registry) and shadcn/ui, under the MIT license. `components.json` records the original registry source. The overlay ScrollArea follows the accepted BB 0.46 package pattern. The public migration also uses BB's SDK icon adapter, bounds Select sizing, and removes unused modal helpers; it does not claim all vendored files are unchanged.

Copyright (c) BB contributors
Copyright (c) 2023 shadcn

## Clasi icon

`icons/clasi.svg` contains the `BrainIcon` geometry from [Hugeicons](https://hugeicons.com), `@hugeicons/core-free-icons` 4.2.3, under the MIT license.

Created by Hugeicons. The npm package metadata declares the MIT license.

## MIT license for the components above

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

## Installed dependencies

Dependencies retain the licenses distributed in their npm packages. They are installed from this package's lockfile, not copied from a sibling package. React and the Plugin SDK frontend runtime are provided by BB at runtime. No private BB modules are vendored here.
