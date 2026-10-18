# Media

Map tiles, place names, ImageSearch, and remote pictures come through Pages' web lookups (Mapbox, Photon, Wikimedia Commons). When lookups are off, these show a short muted note, and Map still draws its places on a blank grid.

## Map

`Map(markers: Marker[], areas?: Area[], center?: string | number[], zoom?: number)`

A map of numbered places (Marker) and shaded regions (Area), with a key below. A position is [lat, lng] or a place name Pages looks up, like "Belém Tower, Lisbon"; give coordinates when you know them. center and zoom (1 world to 18 street, default 13 with a center) fix the view; without them the map fits everything. Readers drag to pan, use ⌘/Ctrl+scroll or the buttons to zoom, and click a place for its popup.

Trip plan:

```openui-lang
root = Map([Marker("Belém Tower", [38.6916, -9.216], "daytrip", "16th-century fort on the Tagus. Go early.", "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Lisbon_Torre_de_Bel%C3%A9m_BW_2018-10-03_16-33-21.jpg/960px-Lisbon_Torre_de_Bel%C3%A9m_BW_2018-10-03_16-33-21.jpg", "https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower"), Marker("Guesthouse", [38.7118, -9.1300], "stay", "Two nights in Alfama."), Marker("Tram 28 stop", [38.7107, -9.1336], "general", "Ride it uphill, not at noon.", "https://upload.wikimedia.org/wikipedia/commons/thumb/6/62/Tram_28_Lisbon_Portuguese.jpg/960px-Tram_28_Lisbon_Portuguese.jpg"), Marker("Rua Augusta at noon", [38.7101, -9.1366], "avoid", "Packed with tour groups.")], [Area("Alfama", [[38.7148, -9.1345], [38.7152, -9.1262], [38.7098, -9.1250], [38.7090, -9.1322]], "stay", "Old quarter: steep lanes, good rooms.")])
```

Places by name:

```openui-lang
root = Map([Marker("Lisbon", "Lisbon, Portugal"), Marker("Sintra", "Sintra, Portugal", "daytrip", "Pena Palace and the Moorish Castle."), Marker("Cascais", "Cascais, Portugal", "daytrip", "Beach town at the end of the train line.")])
```

Fixed view:

```openui-lang
root = Map([Marker("Time Out Market", [38.7069, -9.1459], "general", "Food hall by Cais do Sodré.")], null, [38.7069, -9.1459], 16)
```

## Marker

`Marker(title: string, at: string | number[], kind?: "general" | "stay" | "daytrip" | "avoid", description?: string, image?: string, link?: string)`

One numbered place of Map. at is [lat, lng] or a place name. kind "general" (default, indigo), "stay" (green), "daytrip" (amber), or "avoid" (red). description, image (an http(s) URL), and link (an http(s) URL) fill the popup that opens when it is clicked.

## Area

`Area(title: string, points: number[][], kind?: "general" | "stay" | "daytrip" | "avoid", description?: string)`

A shaded region of Map: points are three or more [lat, lng] corners in order. kind "general" (default, indigo), "stay" (green), "daytrip" (amber), or "avoid" (red). description shows in its popup.

## Gallery

`Gallery(items: (string | Photo)[], columns?: number)`

A grid of pictures; clicking one opens it full size, with previous and next. Each item is an image URL or a Photo with a caption. columns is 1 to 6; by default one picture fills the width, two or four sit in pairs, and more go in threes.

Captioned photos:

```openui-lang
root = Gallery([Photo("https://upload.wikimedia.org/wikipedia/commons/thumb/6/62/Tram_28_Lisbon_Portuguese.jpg/960px-Tram_28_Lisbon_Portuguese.jpg", "Tram 28 in the old town"), Photo("https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Lisbon_Torre_de_Bel%C3%A9m_BW_2018-10-03_16-33-21.jpg/960px-Lisbon_Torre_de_Bel%C3%A9m_BW_2018-10-03_16-33-21.jpg", "Belém Tower"), Photo("https://upload.wikimedia.org/wikipedia/commons/thumb/7/74/Sintra_Portugal_Pal%C3%A1cio_da_Pena-01.jpg/960px-Sintra_Portugal_Pal%C3%A1cio_da_Pena-01.jpg", "Pena Palace, Sintra"), Photo("https://upload.wikimedia.org/wikipedia/commons/thumb/b/b0/Alfama%2C_Lisbon_%28DSC03367%29.jpg/960px-Alfama%2C_Lisbon_%28DSC03367%29.jpg", "Alfama rooftops")])
```

Links in three columns:

```openui-lang
root = Gallery(["https://upload.wikimedia.org/wikipedia/commons/thumb/7/74/Sintra_Portugal_Pal%C3%A1cio_da_Pena-01.jpg/960px-Sintra_Portugal_Pal%C3%A1cio_da_Pena-01.jpg", "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Lisbon_Torre_de_Bel%C3%A9m_BW_2018-10-03_16-33-21.jpg/960px-Lisbon_Torre_de_Bel%C3%A9m_BW_2018-10-03_16-33-21.jpg", "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b0/Alfama%2C_Lisbon_%28DSC03367%29.jpg/960px-Alfama%2C_Lisbon_%28DSC03367%29.jpg"], 3)
```

## Photo

`Photo(src: string, caption?: string, alt?: string)`

One picture of Gallery: src is an http(s) or data: image URL, caption a short line under it, alt describes it for screen readers (default: the caption).

## BeforeAfter

`BeforeAfter(items: {label: string, src: string, alt: string, tone?: "positive" | "negative" | "warning", caption?: string}[])`

Two or more pictures side by side to compare, like Before and After or option A and B; they stack on a narrow screen. Each item is {"label", "src", "alt", "tone", "caption"}: label heads the column, src is an http(s) or data: image URL, alt describes it, tone "positive"|"negative"|"warning" puts a coloured dot by the label, and caption is a line under it. Clicking a picture opens it full size.

Before and after:

```openui-lang
root = BeforeAfter([{"label": "Before", "src": "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%20480%20300'%3E%3Crect%20width%3D'480'%20height%3D'300'%20fill%3D'%23f4f4f5'%2F%3E%3Cg%20fill%3D'%23d4d4d8'%3E%3Crect%20x%3D'32'%20y%3D'28'%20width%3D'220'%20height%3D'16'%2F%3E%3Crect%20x%3D'32'%20y%3D'64'%20width%3D'416'%20height%3D'22'%2F%3E%3Crect%20x%3D'32'%20y%3D'98'%20width%3D'200'%20height%3D'22'%2F%3E%3Crect%20x%3D'248'%20y%3D'98'%20width%3D'200'%20height%3D'22'%2F%3E%3Crect%20x%3D'32'%20y%3D'132'%20width%3D'416'%20height%3D'22'%2F%3E%3Crect%20x%3D'32'%20y%3D'166'%20width%3D'130'%20height%3D'22'%2F%3E%3Crect%20x%3D'175'%20y%3D'166'%20width%3D'130'%20height%3D'22'%2F%3E%3Crect%20x%3D'318'%20y%3D'166'%20width%3D'130'%20height%3D'22'%2F%3E%3Crect%20x%3D'32'%20y%3D'200'%20width%3D'416'%20height%3D'22'%2F%3E%3C%2Fg%3E%3Crect%20x%3D'32'%20y%3D'244'%20width%3D'70'%20height%3D'26'%20fill%3D'%23a1a1aa'%2F%3E%3Crect%20x%3D'112'%20y%3D'244'%20width%3D'70'%20height%3D'26'%20fill%3D'%23a1a1aa'%2F%3E%3Crect%20x%3D'192'%20y%3D'244'%20width%3D'70'%20height%3D'26'%20fill%3D'%23a1a1aa'%2F%3E%3C%2Fsvg%3E", "alt": "Sign-up form with nine fields and three buttons", "tone": "negative", "caption": "Nine fields, three equal buttons."}, {"label": "After", "src": "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%20480%20300'%3E%3Crect%20width%3D'480'%20height%3D'300'%20fill%3D'%23f4f4f5'%2F%3E%3Crect%20x%3D'32'%20y%3D'40'%20width%3D'180'%20height%3D'18'%20fill%3D'%23a1a1aa'%2F%3E%3Cg%20fill%3D'%23e4e4e7'%20stroke%3D'%23d4d4d8'%3E%3Crect%20x%3D'32'%20y%3D'84'%20width%3D'416'%20height%3D'34'%2F%3E%3Crect%20x%3D'32'%20y%3D'138'%20width%3D'416'%20height%3D'34'%2F%3E%3C%2Fg%3E%3Crect%20x%3D'32'%20y%3D'206'%20width%3D'120'%20height%3D'36'%20fill%3D'%236366f1'%2F%3E%3C%2Fsvg%3E", "alt": "Sign-up form with two fields and one primary button", "tone": "positive", "caption": "Two fields and one clear action."}])
```

Two options:

```openui-lang
root = BeforeAfter([{"label": "Option A: Alfama", "src": "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b0/Alfama%2C_Lisbon_%28DSC03367%29.jpg/960px-Alfama%2C_Lisbon_%28DSC03367%29.jpg", "alt": "Rooftops of Alfama above the river", "caption": "Old town, steep lanes, near the river."}, {"label": "Option B: Belém", "src": "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Lisbon_Torre_de_Bel%C3%A9m_BW_2018-10-03_16-33-21.jpg/960px-Lisbon_Torre_de_Bel%C3%A9m_BW_2018-10-03_16-33-21.jpg", "alt": "Belém Tower on the Tagus", "tone": "warning", "caption": "Calmer, but a tram ride from the centre."}])
```

## Hotspots

`Hotspots(image: string, points: Hotspot[], alt?: string)`

A picture with numbered points on it and a key below; picking a point or its row shows its text. image is an http(s) or data: image URL, and alt describes it. Only use it when you know where each feature sits in the picture.

Parts of a building:

```openui-lang
root = Hotspots("https://upload.wikimedia.org/wikipedia/commons/thumb/7/74/Sintra_Portugal_Pal%C3%A1cio_da_Pena-01.jpg/960px-Sintra_Portugal_Pal%C3%A1cio_da_Pena-01.jpg", [Hotspot(22, 20, "Dome tower", "The yellow tower with the grey dome, the **New Palace** side."), Hotspot(67, 26, "Clock tower", "The red tower belongs to the old monastery the palace grew from."), Hotspot(54, 32, "Golden domes", "Two small domes that echo the big one."), Hotspot(40, 66, "Battlements", "Crenellated walls wrap the whole hilltop.")], "Pena Palace in Sintra, yellow and red towers above the trees")
```

## Hotspot

`Hotspot(x: number, y: number, title: string, text?: string)`

One numbered point of Hotspots: x and y are percent across and down the picture (0 to 100), title names it, and text (Markdown) shows when it is picked.

## ImageSearch

`ImageSearch(query: string, count?: number, aspect?: "wide" | "square" | "tall")`

Photos found on the web for query, from Wikimedia Commons, each credited with its author and licence. Use it to show what a place, landmark, plant, animal, or object looks like when you have no image URL. count is 1 (default) to 8. aspect "wide" (default), "square", or "tall" crops them alike. Clicking one opens it full size.

One photo:

```openui-lang
root = ImageSearch("Pena Palace Sintra")
```

A few, square:

```openui-lang
root = ImageSearch("Lisbon tram 28", 4, "square")
```
