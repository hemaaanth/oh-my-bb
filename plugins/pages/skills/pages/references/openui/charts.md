# Charts

## Chart

`Chart(type: "bar" | "line" | "area" | "stackedBar" | "horizontalBar" | "pie" | "donut" | "radar" | "radial" | "scatter" | "funnel" | "histogram" | "box" | "heatmap", labels: (string | number)[], series: Series[], title?: string, xLabel?: string, yLabel?: string, source?: string)`

A chart of Series. Ordinal types use one value per label. Histogram and box use raw observations: histogram labels are increasing numeric bin edges, or [] for shared automatic bins; box draws quartiles, 1.5 IQR whiskers and outliers. Heatmap uses labels as columns and Series as rows. scatter reads numeric labels as x values. source identifies where the numbers came from. xLabel and yLabel name the axes.

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

Histogram:

```openui-lang
root = Chart("histogram", [], [Series("Before", [11, 12, 12, 15, 16, 20, 31]), Series("After", [8, 9, 10, 11, 11, 13])], "Request latency", "Milliseconds", "Requests", "Illustrative")
```

Box plot:

```openui-lang
root = Chart("box", [], [Series("Before", [11, 12, 13, 14, 15, 16, 45]), Series("After", [7, 8, 9, 10, 11, 12])], "Latency distribution", "Milliseconds")
```

Heatmap:

```openui-lang
root = Chart("heatmap", ["Mon", "Tue", "Wed"], [Series("API", [8, 2, 5]), Series("Worker", [1, 9, 4])], "Failures by day")
```

## Series

`Series(name: string, values: (number | string | any)[], tone?: "neutral" | "info" | "success" | "warning" | "danger")`

One named series of a Chart. Ordinal charts take one value per label; histogram and box take raw observations and leave out non-numeric values. null leaves a gap. Optional tone: neutral, info, success, warning, danger.
