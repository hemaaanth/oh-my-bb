# Charts

## Chart

`Chart(type: "bar" | "line" | "area" | "stackedBar" | "horizontalBar" | "pie" | "donut" | "radar" | "radial" | "scatter" | "funnel", labels: (string | number)[], series: Series[], title?: string, xLabel?: string, yLabel?: string)`

A small chart. labels name the x axis points; each Series gives one value per label. bar, line, area, stackedBar, horizontalBar, and radar (labels are the spokes, 3 or more) take several series. pie, donut, radial, and funnel draw the first series only. scatter reads labels as numeric x values and each series as the y for each x. Values are 0 or more, except in scatter. xLabel and yLabel title the bottom and left axes. For anything bigger, publish a page.

Bar:

```openui-lang
root = Chart("bar", ["Mon", "Tue", "Wed"], [Series("Signups", [4, 9, 6]), Series("Churn", [1, 2, 1])])
```

Line:

```openui-lang
root = Chart("line", ["Jan", "Feb", "Mar", "Apr"], [Series("Revenue", [12, 18, 15, 24])])
```

Area with axis titles:

```openui-lang
root = Chart("area", ["W1", "W2", "W3", "W4", "W5"], [Series("Active users", [120, 180, 160, 240, 310]), Series("New", [40, 60, null, 80, 95])], "Weekly users", "Week", "Users")
```

Stacked bar:

```openui-lang
root = Chart("stackedBar", ["Q1", "Q2", "Q3", "Q4"], [Series("Web", [30, 42, 51, 60]), Series("iOS", [12, 18, 22, 30]), Series("Android", [8, 11, 15, 21])], "Revenue by platform")
```

Horizontal bar:

```openui-lang
root = Chart("horizontalBar", ["Search", "Referral", "Social", "Email"], [Series("Visits", [4200, 1800, 950, 600])], "Traffic sources")
```

Pie:

```openui-lang
root = Chart("pie", ["Chrome", "Safari", "Firefox", "Edge"], [Series("Share", [64, 19, 4, 5])], "Browsers")
```

Donut:

```openui-lang
root = Chart("donut", ["Passed", "Failed", "Skipped"], [Series("Tests", [412, 6, 18])], "Test run")
```

Radar:

```openui-lang
root = Chart("radar", ["Speed", "Cost", "Quality", "Support", "Docs"], [Series("Us", [8, 6, 9, 7, 5]), Series("Rival", [6, 8, 6, 5, 7])])
```

Radial:

```openui-lang
root = Chart("radial", ["Move", "Exercise", "Stand"], [Series("Goal %", [82, 60, 95])])
```

Scatter:

```openui-lang
root = Chart("scatter", [1, 2, 3, 5, 8, 13], [Series("Build time", [12, 15, 14, 22, 30, 41]), Series("Test time", [5, 6, null, 9, 14, 18])], "Time by package count", "Packages", "Seconds")
```

Funnel:

```openui-lang
root = Chart("funnel", ["Visited", "Signed up", "Activated", "Paid"], [Series("Users", [5000, 1200, 640, 180])], "Signup funnel")
```

## Series

`Series(name: string, values: number[])`

One named series of a Chart: one number per label. null leaves a gap.
