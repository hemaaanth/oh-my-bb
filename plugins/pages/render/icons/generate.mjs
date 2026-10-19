// Turns the MingCute SVGs (devDependency mingcute_icon) into the three files Pages ships:
//   assets/icons.json                 every glyph, for <i data-icon> on pages (server only)
//   app/spec/icons.generated.tsx      the glyphs chat components draw
//   skills/pages/references/icons.md  the names agents can use
// build.mjs writes them; icons.test.ts fails when they no longer match.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Chat components name glyphs like Lucide did, so a message written before still draws. Each maps to a MingCute name. */
export const GLYPHS = {
  ArrowDown: "arrow_down", ArrowLeft: "arrow_left", ArrowRight: "arrow_right", ArrowUp: "arrow_up", ArrowUpRight: "arrow_right_up",
  Bell: "notification", Book: "book_2", Bookmark: "bookmark", Briefcase: "briefcase", Bug: "bug", Building2: "building_2",
  Calendar: "calendar", Car: "car", ChartBar: "chart_bar", ChartLine: "chart_line", Check: "check",
  ChevronDown: "down", ChevronLeft: "left", ChevronRight: "right", ChevronUp: "up",
  CircleCheck: "check_circle", CircleHelp: "question", CircleX: "close_circle", Clock: "time", Cloud: "cloud", Code: "code",
  Coffee: "teacup", Copy: "copy_2", CreditCard: "bank_card", Database: "cylinder", DollarSign: "currency_dollar", Download: "download_2",
  Ellipsis: "more_1", ExternalLink: "external_link", Eye: "eye_2", File: "file", FileText: "document", Filter: "filter", Flag: "flag_2",
  Folder: "folder", GitBranch: "git_branch", GitCommitHorizontal: "git_commit", GitPullRequest: "git_pull_request", Globe: "world_2",
  GraduationCap: "mortarboard", Heart: "heart", House: "home_4", Image: "pic", Info: "information", Key: "key_2", Lightbulb: "bulb_2",
  Link: "link", Lock: "lock", Mail: "mail", MapPin: "location", Maximize2: "fullscreen_2", MessageSquare: "message_4", Minus: "minimize",
  Moon: "moon", Package: "box_3", Pause: "pause", Pencil: "pencil", Phone: "phone", Plane: "airplane", Play: "play", Plus: "add",
  RefreshCw: "refresh_2", Rocket: "rocket", Search: "search", Send: "send", Server: "server", Settings: "settings_3", Share: "share_2",
  Shield: "shield_shape", ShoppingCart: "shopping_cart_1", Shuffle: "shuffle", Sparkles: "sparkles", Star: "star", Sun: "sun", Tag: "tag",
  Target: "target", Terminal: "terminal_box", ThumbsDown: "thumb_down_2", ThumbsUp: "thumb_up_2", Train: "train", Trash2: "delete_2",
  TrendingDown: "trending_down", TrendingUp: "trending_up", TriangleAlert: "alert", Upload: "upload_2", User: "user_3", Users: "group",
  Utensils: "fork_knife", Wrench: "tool", X: "close", Zap: "flash",
};

/** Short names agents reach for. With GLYPHS, these win over a MingCute name that is the same word. */
const SHORT = {
  x: "close", trash: "delete_2", more: "more_1", external: "external_link", help: "question", idea: "bulb_2", edit: "pencil",
  refresh: "refresh_2", warning: "alert", home: "home_4", branch: "git_branch", cart: "shopping_cart_1", dollar: "currency_dollar",
  bolt: "flash", message: "message_4", building: "building_2", gitcommit: "git_commit", maximize: "fullscreen_2", bell: "notification",
};

/** Lowercase, without spaces, dashes, or underscores: "arrow-right", "Arrow_Right", and "ArrowRight" are one name. */
export const iconKey = (name) => name.toLowerCase().replace(/[\s_-]/gu, "");

// MingCute draws every icon as filled paths on a 24px grid. Each file also has an invisible
// frame path with no fill of its own; only paths with a colour are drawn.
const UNSUPPORTED = /<(linearGradient|pattern|image|use)\b|transform=/u;
const attributes = (source) => Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/gu)].map((m) => [m[1], m[2]]));

/** Each glyph's paths: `d`, plus `fill-rule` and `opacity` where MingCute sets them. Colour is left to currentColor. */
function readGlyph(svg) {
  const groupRule = /<g\b[^>]*\bfill-rule="([^"]*)"/u.exec(svg)?.[1];
  const paths = [];
  for (const match of svg.matchAll(/<path\b([^>]*?)\/?>/gu)) {
    const attrs = attributes(match[1]);
    if (!attrs.d || !/^#[0-9a-f]{6}$/iu.test(attrs.fill ?? "")) continue;
    const path = { d: attrs.d };
    const rule = attrs["fill-rule"] ?? groupRule;
    if (rule === "evenodd") path.fillRule = rule;
    if (attrs.opacity) path.opacity = attrs.opacity;
    paths.push(path);
  }
  if (!paths.length) throw new Error("A MingCute icon has no drawn paths");
  return paths;
}

const inner = (paths) => paths.map((p) => `<path d="${p.d}"${p.fillRule ? ` fill-rule="${p.fillRule}"` : ""}${p.opacity ? ` opacity="${p.opacity}"` : ""}/>`).join("");

/** All three files, as strings, from the MingCute package at `svgRoot`. */
export function generate(svgRoot) {
  const line = {}, fill = {}, categories = {};
  for (const category of readdirSync(svgRoot).sort()) {
    for (const file of readdirSync(join(svgRoot, category)).sort()) {
      const match = /^(.+)_(line|fill)\.svg$/u.exec(file);
      if (!match) continue;
      const svg = readFileSync(join(svgRoot, category, file), "utf8");
      if (UNSUPPORTED.test(svg)) continue;
      const [, name, style] = match;
      const key = iconKey(name);
      const target = style === "line" ? line : fill;
      if (target[key]) throw new Error(`Two MingCute icons share the name ${key}`);
      target[key] = { name, paths: readGlyph(svg) };
      if (style === "line") (categories[category] ??= []).push(name);
    }
  }
  const aliases = {};
  for (const [familiar, name] of [...Object.entries(GLYPHS), ...Object.entries(SHORT)]) {
    if (!line[iconKey(name)]) throw new Error(`${familiar} names ${name}, which MingCute does not have`);
    if (iconKey(familiar) !== iconKey(name)) aliases[iconKey(familiar)] = iconKey(name);
  }

  const json = JSON.stringify({
    line: Object.fromEntries(Object.entries(line).map(([key, glyph]) => [key, inner(glyph.paths)])),
    fill: Object.fromEntries(Object.entries(fill).map(([key, glyph]) => [key, inner(glyph.paths)])),
    aliases,
  });

  const spec = [
    "// Generated by render/icons/build.mjs from MingCute (Apache-2.0). Do not edit.",
    "import { glyph } from \"./glyph.js\";",
    "",
    ...Object.entries(GLYPHS).map(([component, name]) => `export const ${component} = /* @__PURE__ */ glyph(${JSON.stringify(line[iconKey(name)].paths)});`),
    "",
  ].join("\n");

  const familiar = Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)).map(([key, target]) => `${key} → ${line[target].name}`);
  const doc = [
    "# Icons",
    "",
    "<!-- Generated by render/icons/build.mjs. Do not edit. -->",
    "",
    "Pages draws [MingCute](https://www.mingcute.com) icons (Apache-2.0). Write",
    "`<i data-icon=\"name\"></i>` in a page. Pages swaps it for the icon when it",
    "shows the page, in BB and on shared sites. Names ignore case, spaces, dashes,",
    "and underscores. An unknown name shows nothing.",
    "",
    "Every icon has a line style (the default) and a filled style: add `-fill`,",
    "as in `star-fill`. A familiar name below picks a good glyph for that meaning.",
    "Add `-line` or `-fill` to reach the MingCute icon of the same name instead.",
    "",
    "## Familiar names",
    "",
    familiar.join(", "),
    "",
    "## MingCute names",
    "",
    ...Object.entries(categories).flatMap(([category, names]) => [`### ${category}`, "", names.join(", "), ""]),
  ].join("\n");

  return { json, spec, doc, counts: { line: Object.keys(line).length, fill: Object.keys(fill).length } };
}
