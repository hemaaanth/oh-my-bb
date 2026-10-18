# Widgets

Widgets keep their state in the reply; only Quiz with sendScore sends anything to the thread.

## Flashcards

`Flashcards(cards: {front: string, back?: string}[], title?: string)`

Study cards, one at a time. The reader flips a card to see its back, steps with Previous and Next (or arrow keys), and can shuffle.

Terms:

```openui-lang
root = Flashcards([{front: "Idempotent", back: "Running it twice has the same effect as running it once."}, {front: "Backpressure", back: "A slow consumer making a fast producer wait."}, {front: "Tombstone", back: "A marker that records a delete."}], "Systems terms")
```

Empty:

```openui-lang
root = Flashcards([])
```

## Quiz

`Quiz(questions: {q: string, options: string[], answer: number | string, why?: string}[], title?: string, sendScore?: boolean)`

A quiz, one question at a time. answer is the right option's text or its 0-based index; why explains it after a pick. The reader sees right or wrong at once, then a score. With sendScore true, the score screen has a Send score button that sends it to the thread.

Score sent:

```openui-lang
root = Quiz([{q: "Which HTTP status means Not Found?", options: ["200", "301", "404", "500"], answer: "404"}, {q: "Which method should be idempotent?", options: ["POST", "PUT"], answer: 1, why: "PUT replaces the resource, so repeating it changes nothing."}, {q: "What does TTL stand for?", options: ["Time to live", "Total transfer load"], answer: 0}], "HTTP basics", true)
```

Local only:

```openui-lang
root = Quiz([{q: "2 + 2?", options: ["3", "4", "5"], answer: "4", why: "Basic arithmetic."}])
```

## Timer

`Timer(seconds?: number, label?: string)`

A countdown from seconds, or a stopwatch when seconds is left out. The reader starts, pauses, and resets it.

Countdown:

```openui-lang
root = Timer(300, "Standup")
```

Stopwatch:

```openui-lang
root = Timer(null, "Focus")
```

## Walkthrough

`Walkthrough(steps: (string | {title?: string, body?: string, code?: string, language?: string})[], title?: string)`

A step-by-step guide shown one step at a time, with Back and Next, or all at once. steps are strings (the body) or {title?, body?, code?, language?}; body is Markdown, code shows as a code block.

Setup:

```openui-lang
root = Walkthrough([{title: "Install", body: "Add the package to the app.", code: "npm install @acme/sdk", language: "sh"}, {title: "Configure", body: "Set **ACME_KEY** in `.env`."}, {title: "Call it", code: "import { acme } from \"@acme/sdk\";\nawait acme.ping();", language: "ts"}], "Add the SDK")
```

Plain steps:

```openui-lang
root = Walkthrough(["Open Settings.", "Pick Billing.", "Choose Cancel plan and confirm."])
```
