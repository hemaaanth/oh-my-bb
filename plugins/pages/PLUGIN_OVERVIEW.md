Turn an HTML or Markdown file into a durable artifact that reads naturally
inside BB. Pages keeps changed versions together, renders the result inline in
chat, and gives prior work a searchable home instead of leaving it buried in a
thread.

## What you get

Publish with the `page_publish` agent tool or `bb pages publish`. Pages accepts
workspace and thread-storage files, follows stable keys across runs, and skips
duplicate versions when the bytes have not changed.

Organize artifacts into project folders such as `Reports/Weekly`. The Pages
library groups them by project and folder, while `page_browse` lets an agent
find earlier pages by project, folder, or title before updating them.

Pages renders Markdown and sandboxed HTML with a light/dark theme, interactive
data tables, and optional charts. A page can be shared through Here.now with
restricted, password, or public-link access. Sharing requires your own Here.now
API key and explicit confirmation in BB.

## Standalone by default

Pages does not require another BB plugin. If PR Review is installed separately,
it can publish structured review documents and receive actions from their page
menus. That integration remains inactive otherwise.

## Highcharts requirement

Chart pages use the bundled Highcharts runtime. Highcharts is not MIT licensed.
You must obtain and manage your own Highcharts license for your intended use;
installing Pages does not grant one. Pages that do not contain charts do not
load the chart runtime. See the [Highcharts license](https://www.highcharts.com/license).
