Turn an HTML or Markdown file into a durable artifact that reads naturally
inside BB. Pages keeps changed versions together, renders the result inline in
chat, and gives prior work a searchable home instead of leaving it buried in a
thread.

## What you get

Publish with the `page_publish` agent tool or `bb pages publish`. Pages accepts
workspace and thread-storage files, or a whole folder with `index.html` and its
images, styles, and linked pages. It follows stable keys across runs, and skips
duplicate versions when the bytes have not changed. Local images referenced by
path are embedded at publish, so a page stays self-contained when shared.

Organize artifacts into project folders such as `Reports/Weekly`. The Pages
library groups them by project and folder, while `page_browse` lets an agent
find earlier pages by project, folder, or title before updating them.

Pages renders Markdown and sandboxed HTML with a light/dark theme, interactive
data tables, and optional charts. Pages and chat components share one icon
set, MingCute, so icons look the same everywhere and unlike most interfaces.
In chat, a page shows as a compact card, or borderless and inline for a
single chart, table, or diagram. A page can be
shared through Here.now with restricted, password, or public-link access.
Sharing requires your own Here.now API key and explicit confirmation in BB.

To ask for changes, type a note in the page panel's feedback box. Pages sends it
to the thread with the page id, so the agent updates the same page as a new
version.

An agent can also ask questions with a form, right in the chat. When you send
it, the answers go to the thread as one message, each under the label you saw.
The form then stays locked as sent. Pick Edit answers to change them and send
again.

For small things that belong to one reply, an agent skips the page and writes
live UI right in its message: a few numbers, a short table, a bar or line
chart, tabs, code, a diff, or a question with choices and sliders. It draws
as the reply streams and uses BB's own colours and code viewers. Buttons send
to the thread, like page forms. The same components work on a published page
or shared site, read-only, with their data saved when you publish.

## Standalone by default

Pages does not require another BB plugin. If PR Review is installed separately,
it can publish structured review documents and receive actions from their page
menus. That integration remains inactive otherwise.

## Highcharts requirement

Charts on pages and in chat use the bundled Highcharts runtime. Highcharts is not MIT licensed.
You must obtain and manage your own Highcharts license for your intended use;
installing Pages does not grant one. Highcharts loads only when a chart draws. See the [Highcharts license](https://www.highcharts.com/license).
