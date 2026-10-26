# Content

## Heading

`Heading(text: string)`

A section title inside the UI. The reply already names the UI, so do not open with one.

Heading:

```openui-lang
root = Stack([Heading("Open questions"), Text("Two remain.")])
```

## Text

`Text(text: string, tone?: "default" | "muted" | "strong")`

A paragraph of plain text. tone "default"|"muted"|"strong".

Tones:

```openui-lang
root = Stack([Text("Default text."), Text("Muted text.", "muted"), Text("Strong text.", "strong")])
```

## Callout

`Callout(tone: "info" | "success" | "warning" | "danger", title: string, body?: string)`

A short highlighted note with a coloured side bar.

Tones:

```openui-lang
root = Stack([Callout("info", "Heads up", "The API changes on Monday."), Callout("success", "Deployed"), Callout("warning", "Two blockers", "Fix them before Friday."), Callout("danger", "Build failed")])
```

## Stat

`Stat(label: string, value: string | number, change?: string, trend?: "neutral" | "up" | "down", tone?: "neutral" | "info" | "success" | "warning" | "danger", source?: string)`

One headline number. change is a short note under it, like "+12%" or "since May". trend "up" is good (green), "down" is bad (red), "neutral" (default) is muted. tone colours the value itself: "success", "warning", "danger", "info", or "neutral" (default, plain).

With change:

```openui-lang
root = Stat("Signups", 1240, "+12%", "up")
```

Coloured value:

```openui-lang
root = Stats([Stat("Failing tests", 3, "since main", "neutral", "danger"), Stat("Uptime", "99.98%", "30 days", "neutral", "success")])
```

## Stats

`Stats(items: Stat[])`

A row of Stat numbers that wraps on narrow screens.

Three numbers:

```openui-lang
root = Stats([Stat("Signups", 1240, "+12%", "up"), Stat("Churn", "2.1%", "+0.4%", "down"), Stat("Due", "Fri")])
```

## Badge

`Badge(text: string, tone?: "neutral" | "info" | "success" | "warning" | "danger")`

A short status in a tinted pill, like "Shipped", "Blocked", or "3 open". tone "neutral" (default), "info", "success", "warning", or "danger". For a topic or category, use Tag.

Tones:

```openui-lang
root = Stack([Badge("Draft"), Badge("In review", "info"), Badge("Shipped", "success"), Badge("At risk", "warning"), Badge("Blocked", "danger")], "row", "s")
```

## Tag

`Tag(text: string, icon?: string, tone?: "neutral" | "info" | "success" | "warning" | "danger")`

A label for a topic, category, or owner, in a hairline outline. icon is an Icon name shown before the text. tone "neutral" (default), "info", "success", "warning", or "danger" colours the icon, or a small dot when there is no icon. For a status, use Badge.

Plain, dot, and icon:

```openui-lang
root = Stack([Tag("design"), Tag("backend", null, "info"), Tag("Ana", "User"), Tag("Berlin", "MapPin", "danger")], "row", "s")
```

## Chips

`Chips(items: (string | Tag)[])`

A wrapping row of tags. Each item is a plain string or a Tag. For chips the reader picks from, use Choice.

Strings and tags:

```openui-lang
root = Chips(["react", "zod", "vitest", Tag("needs review", "Warning", "warning")])
```

## Icon

`Icon(name: string, tone?: "neutral" | "info" | "success" | "warning" | "danger", label?: string)`

A small icon at the size of the text around it. With no tone it takes the text colour; tone "neutral", "info", "success", "warning", or "danger" colours it. label is read by screen readers; leave it out when the icon only decorates. An unknown name shows nothing. Names: ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Book, Bookmark, Briefcase, Bug, Building, Calendar, Car, ChartBar, ChartLine, Check, CircleCheck, CircleX, Clock, Cloud, Code, Coffee, CreditCard, Database, DollarSign, Download, ExternalLink, Eye, File, FileText, Flag, Folder, GitBranch, GitCommit, GitPullRequest, Globe, GraduationCap, Heart, Home, Image, Info, Key, Lightbulb, Link, Lock, Mail, MapPin, Message, Minus, Moon, Package, Pencil, Phone, Plane, Plus, Rocket, Search, Server, Settings, Shield, ShoppingCart, Sparkles, Star, Sun, Tag, Target, Terminal, Train, Trash, TrendingDown, TrendingUp, Upload, User, Users, Utensils, Warning, Wrench, X, Zap.

Inline and toned:

```openui-lang
root = Stack([Icon("Check", "success", "Done"), Icon("Warning", "warning", "Warning"), Icon("CircleX", "danger", "Failed"), Icon("Rocket"), Icon("GitPullRequest", "info")], "row", "m")
```

## Entity

`Entity(name: string, subtitle?: string, image?: string, facts?: Record<string, any> | any[][], url?: string, kind?: "person" | "place" | "org" | "product" | "link" | "other")`

One person, place, or thing: a picture, the name, a subtitle, and a few facts. facts is an object like {"Rating": 4.6, "Price": "$$"} or a list of [label, value] pairs. image is an http(s) or data: image URL; with none, a kind icon or the first letter stands in. url (http or https) makes the name a link. kind "person", "place", "org", "product", "link", or "other" (default). In a narrow tile, like a Grid or Carousel, the picture goes on top.

Place with photo:

```openui-lang
root = Entity("Eiffel Tower", "Landmark in Paris", "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/640px-Tour_Eiffel_Wikimedia_Commons.jpg", {"Height": "330 m", "Opened": 1889, "Visitors": "6M a year"}, "https://www.toureiffel.paris", "place")
```

Person, no photo:

```openui-lang
root = Entity("Ana Lima", "Staff engineer, Payments", null, [["Team", "Payments"], ["Time zone", "UTC-3"]], null, "person")
```

Tiles:

```openui-lang
root = Grid([Entity("Kyoto", "3 nights", "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/640px-Tour_Eiffel_Wikimedia_Commons.jpg", {"From": "$180"}), Entity("Nara", "Day trip", null, {"Train": "45 min"}, null, "place"), Entity("Osaka", "2 nights", null, {"From": "$140"})])
```

## File

`File(path: string, line?: number)`

A file reference in mono, as path or path:line. An http(s) URL opens on click; a workspace path shows as text.

Path and URL:

```openui-lang
root = Stack([File("src/server/auth.ts", 42), File("README.md"), File("https://github.com/hemaaanth/oh-my-bb/blob/main/README.md")])
```

## Image

`Image(src: string, alt: string, caption?: string)`

A picture from an http(s) or data: image URL. alt describes it for screen readers, and shows in its place if it fails to load. caption is a line under it. Clicking it opens it full size. Other sources, like file paths, show the alt text.

With caption:

```openui-lang
root = Image("https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/640px-Tour_Eiffel_Wikimedia_Commons.jpg", "The Eiffel Tower on a clear day", "Paris, from the Champ de Mars")
```

Cannot load:

```openui-lang
root = Image("/tmp/chart.png", "Weekly signups chart")
```

## KeyValue

`KeyValue(pairs: Record<string, any> | any[][])`

Labels and their values in two aligned columns; on a narrow screen each label sits above its value. pairs is an object like {"Owner": "Ana", "Due": "Fri"} or a list of [label, value] pairs. A value may be text, a number, null (shown as a dash), or a component such as Badge or File.

Object:

```openui-lang
root = KeyValue({"Owner": "Ana Lima", "Status": Badge("In review", "info"), "Due": "Fri 24 Oct", "Budget": 12000, "Notes": null})
```

Pairs:

```openui-lang
root = KeyValue([["Entry point", File("server.ts", 12)], ["Runtime", "Node 22"]])
```

## List

`List(items: any[], ordered?: boolean)`

A bulleted list, or a numbered one with ordered true. Each item is a string or a component, like File or Text. A List right after an item nests under it.

Bullets:

```openui-lang
root = List(["Faster builds", "Smaller bundle", "One config file"])
```

Numbered, nested:

```openui-lang
root = List(["Set up", List(["Install Node 22", "Run npm ci"]), "Build", File("dist/index.js"), "Deploy"], true)
```

## Sources

`Sources(links: (string | Source)[], title?: string)`

The links an answer drew on, numbered in order, so "[2]" in the reply is the second. Each link is a URL string or a Source with a title and note. Only http(s) links open; another link keeps its number and says it cannot open. title heads the list, default "Sources".

With titles:

```openui-lang
root = Sources([Source("https://react.dev/reference/react/useId", "useId", "Stable ids for accessibility attributes."), Source("https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog", "The dialog element"), "https://www.w3.org/WAI/ARIA/apg/patterns/accordion/"])
```

## Source

`Source(url: string, title?: string, note?: string)`

One cited link of Sources: an http(s) url, a title (the domain shows when it is missing), and an optional short note.
