// Widgets: small interactive tools: flashcards, quizzes, timers, walkthroughs. They keep their state locally.
import { useContext, useEffect, useState, type KeyboardEvent } from "react";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { Check, ChevronLeft, ChevronRight, Shuffle, X } from "lucide-react";
import { z } from "zod";
import { SentContext, focusRing, useReadOnly, type Group } from "../kit.js";
import { useHost } from "../host.js";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// Ported from GenUI ui/components/widget-logic.ts (Apache-2.0).
/** A run/pause clock as timestamps, not a tick count, so it stays right when a background tab throttles timers. */
export type Clock = { banked: number; startedAt: number | null };
export const STOPPED: Clock = { banked: 0, startedAt: null };
export const elapsedMs = (clock: Clock, now: number): number => clock.banked + (clock.startedAt === null ? 0 : Math.max(0, now - clock.startedAt));
export const startClock = (clock: Clock, now: number): Clock => (clock.startedAt === null ? { banked: clock.banked, startedAt: now } : clock);
export const pauseClock = (clock: Clock, now: number): Clock => (clock.startedAt === null ? clock : { banked: elapsedMs(clock, now), startedAt: null });

/** mm:ss, or h:mm:ss from an hour up (or always with `hours`, so a long countdown keeps one width). */
export function formatClock(totalSeconds: number, hours = false): string {
  const whole = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return h > 0 || hours ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export type Question = { q: string; options: string[]; answer: number; why?: string };

/** The right option's index: a 0-based index in range, or the option's text (exact, then ignoring case and spaces). */
export function resolveAnswer(answer: unknown, options: readonly string[]): number | null {
  if (typeof answer === "number") return Number.isInteger(answer) && answer >= 0 && answer < options.length ? answer : null;
  if (typeof answer !== "string") return null;
  const exact = options.indexOf(answer);
  if (exact >= 0) return exact;
  const wanted = answer.trim().toLowerCase();
  const loose = wanted === "" ? -1 : options.findIndex((o) => o.trim().toLowerCase() === wanted);
  return loose >= 0 ? loose : null;
}

/** Questions that can be asked: a prompt, two or more options, a valid answer. Others (still streaming, or broken) are skipped. */
export function parseQuestions(items: unknown): Question[] {
  return list(items).flatMap((item): Question[] => {
    const entry = record(item);
    const q = text(entry?.q ?? entry?.question);
    const options = list(entry?.options).map(text);
    if (!entry || q === "" || options.length < 2 || options.some((o) => o === "")) return [];
    const answer = resolveAnswer(entry.answer, options);
    return answer === null ? [] : [{ q, options, answer, why: text(entry.why) || undefined }];
  });
}

export const quizScore = (questions: readonly Question[], picks: readonly (number | undefined)[]): number => questions.filter((question, index) => picks[index] === question.answer).length;

export type Card = { front: string; back: string };

/** Cards with a front; a missing back reads as empty rather than dropping the card. */
export const parseCards = (items: unknown): Card[] => list(items).flatMap((item): Card[] => {
  const entry = record(item);
  const front = text(entry?.front);
  return front ? [{ front, back: text(entry?.back) }] : [];
});

/** A viewing order for `count` cards built on `order`: gone positions dropped, new ones (cards still streaming in) appended. */
export function reconcileOrder(order: readonly number[], count: number): number[] {
  const kept = [...new Set(order)].filter((index) => Number.isInteger(index) && index >= 0 && index < count);
  for (let index = 0; index < count; index++) if (!kept.includes(index)) kept.push(index);
  return kept;
}

/** A Fisher–Yates shuffle. One that lands on the same order would look like a dead button, so that case swaps the first two. */
export function shuffleOrder(order: readonly number[], random: () => number = Math.random): number[] {
  const result = [...order];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  if (result.length > 1 && result.every((value, index) => value === order[index])) [result[0], result[1]] = [result[1]!, result[0]!];
  return result;
}

export type Step = { title: string; body: string; code?: string; language?: string };

// Ported from GenUI ui/components/explain-logic.ts (Apache-2.0).
/** Steps with a title, body, or code; a bare string is a step's body. Empty entries are skipped. */
export const parseSteps = (items: unknown): Step[] => list(items).flatMap((item): Step[] => {
  if (typeof item === "string" || typeof item === "number") return text(item) ? [{ title: "", body: text(item) }] : [];
  const entry = record(item);
  if (!entry) return [];
  const title = text(entry.title), body = text(entry.body ?? entry.text);
  const code = typeof entry.code === "string" && entry.code.trim() !== "" ? entry.code.replace(/\n+$/, "") : undefined;
  return title || body || code ? [{ title, body, code, language: text(entry.language) || undefined }] : [];
});

const plainButton = `inline-flex w-fit cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-foreground hover:bg-state-hover disabled:cursor-default disabled:opacity-40 ${focusRing}`;
const solidButton = `w-fit cursor-pointer rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-60 ${focusRing}`;

/** A thin progress bar; `share` is 0 to 1. */
const Bar = ({ share, label }: { share: number; label: string }) => <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} className="h-1 w-full overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${Math.min(1, Math.max(0, share)) * 100}%` }} /></div>;

const Flashcards = defineComponent({
  name: "Flashcards",
  props: z.object({ cards: z.array(z.object({ front: z.string(), back: z.string().optional() })), title: z.string().optional() }),
  description: "Study cards, one at a time. The reader flips a card to see its back, steps with Previous and Next (or arrow keys), and can shuffle.",
  component: ({ props }) => {
    const cards = parseCards(props.cards);
    const [order, setOrder] = useState<number[]>([]);
    const [at, setAt] = useState(0);
    const [flipped, setFlipped] = useState(false);
    const shown = reconcileOrder(order, cards.length);
    const position = Math.min(at, Math.max(0, cards.length - 1));
    const card = cards[shown[position]!];
    const go = (next: number) => { if (next >= 0 && next < cards.length) { setAt(next); setFlipped(false); } };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") go(position - 1);
      else if (event.key === "ArrowRight") go(position + 1);
    };
    return <div role="group" aria-label={props.title ?? "Flashcards"} className="flex flex-col gap-2" onKeyDown={onKey}>
      {props.title ? <span className="font-medium text-foreground">{props.title}</span> : null}
      {card ? <button type="button" aria-pressed={flipped} onClick={() => setFlipped(!flipped)} className={`flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-border-hairline p-4 text-center ${focusRing}`}>
        <span className="text-muted-foreground">{flipped ? "Back" : "Front"}</span>
        <span className="text-lg text-foreground">{flipped ? card.back || "No back" : card.front}</span>
        {flipped ? null : <span className="text-muted-foreground">Click to flip</span>}
      </button> : <p className="m-0 text-muted-foreground">No cards yet</p>}
      <div className="flex items-center gap-1">
        <button type="button" disabled={position === 0} onClick={() => go(position - 1)} className={plainButton}><ChevronLeft className="size-4" aria-hidden />Previous</button>
        <span className="tabular-nums text-muted-foreground">{cards.length ? position + 1 : 0} / {cards.length}</span>
        <button type="button" disabled={position >= cards.length - 1} onClick={() => go(position + 1)} className={plainButton}>Next<ChevronRight className="size-4" aria-hidden /></button>
        <button type="button" disabled={cards.length < 2} onClick={() => { setOrder(shuffleOrder(shown)); go(0); }} className={`${plainButton} ml-auto`}><Shuffle className="size-4" aria-hidden />Shuffle</button>
      </div>
    </div>;
  },
});

const Quiz = defineComponent({
  name: "Quiz",
  props: z.object({
    questions: z.array(z.object({ q: z.string(), options: z.array(z.string()), answer: z.union([z.number(), z.string()]), why: z.string().optional() })),
    title: z.string().optional(),
    sendScore: z.boolean().optional(),
  }),
  description: "A quiz, one question at a time. answer is the right option's text or its 0-based index; why explains it after a pick. The reader sees right or wrong at once, then a score. With sendScore true, the score screen has a Send score button that sends it to the thread.",
  component: ({ props }) => {
    const questions = parseQuestions(props.questions);
    const [at, setAt] = useState(0);
    const [picks, setPicks] = useState<(number | undefined)[]>([]);
    const [done, setDone] = useState(false);
    const trigger = useTriggerAction();
    const sent = useContext(SentContext).sent[""];
    const streaming = useIsStreaming();
    // The score stays on the page where it cannot be sent: the quiz itself works anywhere.
    const readOnly = useReadOnly();
    const sendScore = props.sendScore && !readOnly;
    const index = Math.min(at, Math.max(0, questions.length - 1));
    const question = questions[index];
    const pick = picks[index];
    const score = quizScore(questions, picks);
    const scoreText = `Quiz score: ${score} of ${questions.length}${props.title ? ` (${props.title})` : ""}`;
    if (!question) return <p className="m-0 text-muted-foreground">No questions yet</p>;
    if (done) return <div role="group" aria-label={props.title ?? "Quiz"} className="flex flex-col gap-2">
      {props.title ? <span className="font-medium text-foreground">{props.title}</span> : null}
      <p role="status" className="m-0 text-lg text-foreground">{score} of {questions.length} correct</p>
      <div className="flex flex-wrap items-center gap-2">
        {sendScore ? <button type="button" aria-pressed={sent === undefined ? undefined : sent === scoreText} disabled={streaming || sent !== undefined} onClick={() => void trigger(scoreText, undefined)} className={solidButton}>{sent === scoreText ? "Score sent" : "Send score"}</button> : null}
        <button type="button" onClick={() => { setPicks([]); setAt(0); setDone(false); }} className={plainButton}>Retry</button>
      </div>
    </div>;
    return <div role="group" aria-label={props.title ?? "Quiz"} className="flex flex-col gap-2">
      <span className="flex items-baseline justify-between gap-3">{props.title ? <span className="font-medium text-foreground">{props.title}</span> : <span />}<span className="tabular-nums text-muted-foreground">Question {index + 1} of {questions.length}</span></span>
      <p className="m-0 text-foreground">{question.q}</p>
      <div className="flex flex-col gap-1.5">{question.options.map((option, choice) => {
        const right = pick !== undefined && choice === question.answer;
        const wrong = pick === choice && !right;
        return <button key={choice} type="button" aria-pressed={pick === choice} disabled={pick !== undefined} onClick={() => setPicks((all) => { const next = [...all]; next[index] = choice; return next; })}
          className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-left disabled:cursor-default ${focusRing} ${right ? "border-success text-success" : wrong ? "border-destructive text-destructive" : `border-input text-foreground ${pick === undefined ? "hover:bg-state-hover" : "opacity-60"}`}`}>
          <span className="min-w-0 flex-1">{option}</span>{right ? <Check className="size-4 shrink-0" aria-label="Right" /> : wrong ? <X className="size-4 shrink-0" aria-label="Wrong" /> : null}
        </button>;
      })}</div>
      {pick !== undefined ? <p role="status" className="m-0 text-muted-foreground">{pick === question.answer ? "Right." : `Not quite. The answer is ${question.options[question.answer]}.`}{question.why ? ` ${question.why}` : ""}</p> : null}
      <div className="flex items-center gap-1">
        <button type="button" disabled={index === 0} onClick={() => setAt(index - 1)} className={plainButton}><ChevronLeft className="size-4" aria-hidden />Back</button>
        {index < questions.length - 1
          ? <button type="button" onClick={() => setAt(index + 1)} className={plainButton}>Next<ChevronRight className="size-4" aria-hidden /></button>
          : <button type="button" disabled={streaming} onClick={() => setDone(true)} className={plainButton}>See score<ChevronRight className="size-4" aria-hidden /></button>}
      </div>
    </div>;
  },
});

const Timer = defineComponent({
  name: "Timer",
  props: z.object({ seconds: z.number().optional(), label: z.string().optional() }),
  description: "A countdown from seconds, or a stopwatch when seconds is left out. The reader starts, pauses, and resets it.",
  component: ({ props }) => {
    const total = typeof props.seconds === "number" && props.seconds > 0 ? props.seconds * 1000 : null;
    const [clock, setClock] = useState<Clock>(STOPPED);
    const [now, setNow] = useState(() => Date.now());
    const running = clock.startedAt !== null;
    const elapsed = elapsedMs(clock, now);
    const finished = total !== null && elapsed >= total;
    useEffect(() => {
      if (!running) return;
      const timer = setInterval(() => setNow(Date.now()), 200);
      return () => clearInterval(timer);
    }, [running]);
    useEffect(() => { if (finished && running) setClock(pauseClock(clock, now)); }, [finished, running, clock, now]);
    const seconds = total === null ? elapsed / 1000 : Math.ceil(Math.max(0, total - elapsed) / 1000);
    const hours = total !== null && total >= 3_600_000;
    const toggle = () => { const at = Date.now(); setNow(at); setClock(running ? pauseClock(clock, at) : startClock(clock, at)); };
    return <div role="group" aria-label={props.label ?? "Timer"} className="flex flex-col gap-2">
      {props.label ? <span className="text-muted-foreground">{props.label}</span> : null}
      <span role="timer" className={`font-mono text-3xl tabular-nums ${finished ? "text-success" : "text-foreground"}`}>{formatClock(seconds, hours)}</span>
      {total !== null ? <Bar share={elapsed / total} label="Time used" /> : null}
      {finished ? <p role="status" className="m-0 text-foreground">Time's up</p> : null}
      <div className="flex items-center gap-2">
        <button type="button" disabled={finished} onClick={toggle} className={solidButton}>{running ? "Pause" : elapsed > 0 ? "Resume" : "Start"}</button>
        <button type="button" disabled={elapsed === 0} onClick={() => setClock(STOPPED)} className={plainButton}>Reset</button>
      </div>
    </div>;
  },
});

const Walkthrough = defineComponent({
  name: "Walkthrough",
  props: z.object({ steps: z.array(z.union([z.string(), z.object({ title: z.string().optional(), body: z.string().optional(), code: z.string().optional(), language: z.string().optional() })])), title: z.string().optional() }),
  description: "A step-by-step guide shown one step at a time, with Back and Next, or all at once. steps are strings (the body) or {title?, body?, code?, language?}; body is Markdown, code shows as a code block.",
  component: ({ props }) => {
    const { Markdown, SourceCode } = useHost();
    const steps = parseSteps(props.steps);
    const [at, setAt] = useState(0);
    const [all, setAll] = useState(false);
    const index = Math.min(at, Math.max(0, steps.length - 1));
    if (!steps.length) return <p className="m-0 text-muted-foreground">No steps yet</p>;
    const view = (step: Step, n: number) => <section key={n} aria-label={step.title || `Step ${n + 1}`} className="flex flex-col gap-2">
      {step.title ? <span className="font-medium text-foreground">{all ? `${n + 1}. ` : ""}{step.title}</span> : all ? <span className="font-medium text-foreground">Step {n + 1}</span> : null}
      {step.body ? <Markdown content={step.body} /> : null}
      {step.code ? <SourceCode content={step.code} path={`step.${step.language ?? "txt"}`} /> : null}
    </section>;
    return <div role="group" aria-label={props.title ?? "Walkthrough"} className="flex flex-col gap-3">
      <span className="flex items-baseline justify-between gap-3">
        {props.title ? <span className="font-medium text-foreground">{props.title}</span> : <span />}
        <button type="button" onClick={() => setAll(!all)} className={`cursor-pointer rounded-sm text-muted-foreground hover:text-foreground ${focusRing}`}>{all ? "One at a time" : "Show all"}</button>
      </span>
      {all ? steps.map(view) : <>
        <span className="flex items-center gap-3">
          <span className="shrink-0 tabular-nums text-muted-foreground">Step {index + 1} of {steps.length}</span>
          {steps.length <= 12
            ? <span className="flex flex-1 gap-1" aria-hidden>{steps.map((_, n) => <span key={n} className={`h-1 flex-1 rounded-full ${n <= index ? "bg-primary" : "bg-muted"}`} />)}</span>
            : <span className="flex-1"><Bar share={(index + 1) / steps.length} label="Progress" /></span>}
        </span>
        {view(steps[index]!, index)}
        <div className="flex items-center gap-1">
          <button type="button" disabled={index === 0} onClick={() => setAt(index - 1)} className={plainButton}><ChevronLeft className="size-4" aria-hidden />Back</button>
          {index < steps.length - 1
            ? <button type="button" onClick={() => setAt(index + 1)} className={plainButton}>Next<ChevronRight className="size-4" aria-hidden /></button>
            : <button type="button" onClick={() => setAt(0)} className={plainButton}>Start over</button>}
        </div>
      </>}
    </div>;
  },
});

export const group: Group = {
  id: "widgets",
  name: "Widgets",
  notes: ["Widgets keep their state in the reply; only Quiz with sendScore sends anything to the thread."],
  entries: [
    { component: Flashcards, summary: "study cards to flip", examples: [
      { name: "Terms", code: `root = Flashcards([{front: "Idempotent", back: "Running it twice has the same effect as running it once."}, {front: "Backpressure", back: "A slow consumer making a fast producer wait."}, {front: "Tombstone", back: "A marker that records a delete."}], "Systems terms")` },
      { name: "Empty", code: `root = Flashcards([])` },
    ] },
    { component: Quiz, summary: "questions with right/wrong and a score", examples: [
      { name: "Score sent", code: `root = Quiz([{q: "Which HTTP status means Not Found?", options: ["200", "301", "404", "500"], answer: "404"}, {q: "Which method should be idempotent?", options: ["POST", "PUT"], answer: 1, why: "PUT replaces the resource, so repeating it changes nothing."}, {q: "What does TTL stand for?", options: ["Time to live", "Total transfer load"], answer: 0}], "HTTP basics", true)` },
      { name: "Local only", code: `root = Quiz([{q: "2 + 2?", options: ["3", "4", "5"], answer: "4", why: "Basic arithmetic."}])` },
    ] },
    { component: Timer, summary: "countdown or stopwatch", examples: [
      { name: "Countdown", code: `root = Timer(300, "Standup")` },
      { name: "Stopwatch", code: `root = Timer(null, "Focus")` },
    ] },
    { component: Walkthrough, summary: "step-by-step guide", examples: [
      { name: "Setup", code: "root = Walkthrough([{title: \"Install\", body: \"Add the package to the app.\", code: \"npm install @acme/sdk\", language: \"sh\"}, {title: \"Configure\", body: \"Set **ACME_KEY** in `.env`.\"}, {title: \"Call it\", code: \"import { acme } from \\\"@acme/sdk\\\";\\nawait acme.ping();\", language: \"ts\"}], \"Add the SDK\")" },
      { name: "Plain steps", code: `root = Walkthrough(["Open Settings.", "Pick Billing.", "Choose Cancel plan and confirm."])` },
    ] },
  ],
};
