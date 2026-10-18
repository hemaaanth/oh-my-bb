# Layout

## Stack

`Stack(children: any[], direction?: "column" | "row", gap?: "none" | "s" | "m" | "l")`

Layout. direction "column" (default) or "row"; rows wrap. gap "none"|"s"|"m"|"l", default "m".

Column:

```openui-lang
root = Stack([Text("First"), Text("Second")])
```

Row:

```openui-lang
root = Stack([Text("Left"), Text("Right")], "row", "l")
```

## Card

`Card(children: any[], title?: string, variant?: "card" | "sunk" | "clear")`

A framed group of parts with an optional title. variant "card" (default) has a hairline frame; "sunk" is a muted tile, good for options side by side; "clear" has no frame. A "card" inside another Card draws as "sunk". Cards in a Row or Grid share one height.

Card:

```openui-lang
root = Card([Text("Two blockers remain before the release."), Stack([Badge("In review", "info"), Badge("Due Fri")], "row", "s")], "Release 2.4")
```

Nested:

```openui-lang
root = Card([Row([Card([Text("Ship Friday with the known bug.")], "Ship"), Card([Text("Wait a week for the fix.")], "Wait")])], "Two options")
```

Variants:

```openui-lang
root = Stack([Card([Text("A hairline frame.")], "Card"), Card([Text("A muted tile.")], "Sunk", "sunk"), Card([Text("No frame, only spacing.")], "Clear", "clear")])
```

## Row

`Row(children: any[], gap?: "none" | "s" | "m" | "l")`

Parts side by side in equal columns. Each column is at least 10rem wide, so a narrow screen wraps them. gap "none"|"s"|"m"|"l", default "l". For buttons or small items at their own width, use Stack with "row".

Three columns:

```openui-lang
root = Row([Card([Text("Postgres")], "Database", "sunk"), Card([Text("Redis")], "Cache", "sunk"), Card([Text("S3")], "Files", "sunk")])
```

## Grid

`Grid(children: any[], columns?: number)`

Tiles on an even grid. With no columns it fits as many tiles of about 10rem as there is room for. columns (1 to 6) asks for that many; a narrow screen shows fewer, each at least 8rem. Tiles in a row share one height.

Fit to width:

```openui-lang
root = Grid([Stat("Users", 1240), Stat("Teams", 86), Stat("Seats", 3100), Stat("Churn", "2.1%"), Stat("NPS", 48)])
```

Two columns:

```openui-lang
root = Grid([Card([Text("Faster builds.")], "Pro", "sunk"), Card([Text("A smaller bundle.")], "Pro", "sunk"), Card([Text("A new config format.")], "Con", "sunk"), Card([Text("One more plugin to keep.")], "Con", "sunk")], 2)
```

## Carousel

`Carousel(items: any[], label?: string)`

A row of slides that scrolls sideways, with previous and next buttons. Each item is one slide, often a Card or an Entity. Slides are about 16rem wide. label names the carousel for screen readers.

Cards:

```openui-lang
root = Carousel([Card([Text("Kyoto, 3 nights")], "Day 1-3", "sunk"), Card([Text("Nara, day trip")], "Day 4", "sunk"), Card([Text("Osaka, 2 nights")], "Day 5-6", "sunk"), Card([Text("Fly home")], "Day 7", "sunk")], "Trip plan")
```

## Details

`Details(title: string, children: any[], open?: boolean)`

A collapsible section: the title shows, the content opens on click. Closed unless open is true. Use it for detail most readers skip.

Closed and open:

```openui-lang
root = Stack([Details("Why this works", [Text("The cache holds the last good build, so a retry is cheap.")]), Details("Steps", [List(["Clear the cache", "Run the build", "Check the logs"], true)], true)])
```

## Divider

`Divider(label?: string)`

A thin line between parts. With a label, the label sits in the middle of the line.

Plain and labelled:

```openui-lang
root = Stack([Text("Above the line."), Divider(), Text("Below the line."), Divider("or"), Text("Another way.")])
```

## Accordion

`Accordion(items: AccordionItem[])`

Stacked sections where one opens at a time; the first starts open. Clicking an open title closes it. Up and down arrows move between titles. While the reply streams, the newest section opens until the reader clicks one.

FAQ:

```openui-lang
root = Accordion([AccordionItem("What is included?", [Text("Hosting, backups, and email support.")]), AccordionItem("Can I cancel?", [Text("Yes, any time. You keep access to the end of the month.")]), AccordionItem("Is there a free tier?", [Text("Yes, for one project.")])])
```

## AccordionItem

`AccordionItem(title: string, children: any[])`

One section of an Accordion: a title and its content.

## Modal

`Modal(label: string, children: any[], title?: string)`

A button that opens a dialog with the children inside. label is the button text; title heads the dialog and defaults to label. Escape, the close button, or a click outside closes it. Use it for detail or a Form that should not take room in the reply.

Details in a dialog:

```openui-lang
root = Modal("See the full log", [Text("The build failed at step 4 of 6."), Code("text", "error: cannot find module 'zod'")], "Build log")
```

Form in a dialog:

```openui-lang
root = Modal("Change the plan", [Form("plan", [Choice("tier", ["Free", "Pro", "Team"], "Tier")], [Button("Save")])])
```

## Tabs

`Tabs(tabs: Tab[])`

Switch between a few views of related content. The first tab shows first.

Two tabs:

```openui-lang
root = Tabs([Tab("Summary", [Text("Shipped on time.")]), Tab("Notes", [Text("Docs follow next week.", "muted")])])
```

## Tab

`Tab(label: string, children: any[])`

One tab of Tabs: a label and its content.
