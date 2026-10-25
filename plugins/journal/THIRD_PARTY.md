# Third-party notices

## Agent Calendar

The turn index, calendar math and layout, time sheet, CLI formatting, and related tests derive from [Agent Calendar](https://github.com/charpeni/bb-plugins/tree/main/plugins/agent-calendar) by charpeni. Source headers retain the attribution.

MIT License

Copyright (c) charpeni

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

## BB and shared UI

`components/ui/` and `lib/` contain vendored BB plugin-registry and shadcn/ui-derived controls (MIT). `components.json` records the registry source. The icon wrapper uses the host SDK icon component; static Journal surfaces use `assets/journal.svg`.

React, React DOM, the BB Plugin SDK, and the Radix dialog/select modules are supplied by the host at runtime. Package-local development dependencies provide their declarations and isolated validation runtime. The host owns overlay focus, Escape, and outside-click behavior.

## Dependencies

The lockfile records exact versions and registry integrity hashes. Dependencies retain their own licenses. Relevant direct components include Radix UI (MIT), Zod (MIT), clsx (MIT), tailwind-merge (MIT), class-variance-authority (Apache-2.0), and Sonner (MIT). BB's builder decides which host-shimmed modules remain external. Development tools and their transitive dependencies are not Journal runtime services.
