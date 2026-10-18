// @vitest-environment jsdom
// Widget rules, ported from GenUI ui/components/widget-logic.test.ts and explain-logic.test.ts (Apache-2.0), and a Quiz run.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Renderer, type ActionEvent } from "@openuidev/react-lang";
import { specLibrary } from "../catalog.js";
import { fallbackHost, HostContext } from "../host.js";
import { STOPPED, elapsedMs, formatClock, parseCards, parseQuestions, parseSteps, pauseClock, quizScore, reconcileOrder, resolveAnswer, shuffleOrder, startClock } from "./widgets.js";

// A host that can send to the thread, like chat. The default host is a page, where sending is read-only.
const chat = { ...fallbackHost, kind: "chat" as const, replies: true };

afterEach(cleanup);

describe("Timer clock", () => {
  it("banks time across runs and ignores repeated starts and pauses", () => {
    const running = startClock(STOPPED, 1000);
    expect(startClock(running, 5000)).toBe(running);
    const paused = pauseClock(running, 4000);
    expect(paused).toEqual({ banked: 3000, startedAt: null });
    expect(pauseClock(paused, 9000)).toBe(paused);
    expect(elapsedMs(startClock(paused, 10_000), 10_500)).toBe(3500);
  });

  it("formats mm:ss, and h:mm:ss from an hour or on request", () => {
    expect([formatClock(0), formatClock(65.9), formatClock(3725), formatClock(59, true), formatClock(-5), formatClock(NaN)]).toEqual(["00:00", "01:05", "1:02:05", "0:00:59", "00:00", "00:00"]);
  });
});

describe("Quiz questions", () => {
  it("finds the answer by index or text", () => {
    const options = ["Red", "Green"];
    expect([resolveAnswer(1, options), resolveAnswer(2, options), resolveAnswer(0.5, options), resolveAnswer("Green", options), resolveAnswer(" green ", options), resolveAnswer("Blue", options), resolveAnswer(null, options)]).toEqual([1, null, null, 1, 1, null, null]);
  });

  it("skips questions that cannot be asked yet", () => {
    expect(parseQuestions([{ q: "A?", options: ["x", "y"], answer: "y", why: " Because. " }, { q: "B?", options: ["x"], answer: 0 }, { q: "", options: ["x", "y"], answer: 0 }, { q: "C?", options: ["x", "y"] }, null, "D?"])).toEqual([
      { q: "A?", options: ["x", "y"], answer: 1, why: "Because." },
    ]);
    expect(parseQuestions(undefined)).toEqual([]);
  });

  it("counts unanswered questions as wrong", () => {
    const questions = parseQuestions([{ q: "A?", options: ["x", "y"], answer: 0 }, { q: "B?", options: ["x", "y"], answer: 1 }]);
    expect([quizScore(questions, [0, 1]), quizScore(questions, [0]), quizScore(questions, [1, 0])]).toEqual([2, 1, 0]);
  });
});

describe("Flashcards", () => {
  it("keeps cards with a front, even without a back", () => {
    expect(parseCards([{ front: "A", back: "a" }, { front: "B" }, { back: "c" }, "D"])).toEqual([{ front: "A", back: "a" }, { front: "B", back: "" }]);
  });

  it("keeps a shuffled order while cards stream in", () => {
    expect(reconcileOrder([2, 0, 1], 4)).toEqual([2, 0, 1, 3]);
    expect(reconcileOrder([2, 0, 0, 5, 1], 2)).toEqual([0, 1]);
  });

  it("never shuffles into the same order", () => {
    expect(shuffleOrder([0, 1, 2], () => 0.999)).toEqual([1, 0, 2]);
    expect(shuffleOrder([0, 1, 2], () => 0)).toEqual([1, 2, 0]);
    expect(shuffleOrder([0])).toEqual([0]);
  });
});

describe("Walkthrough steps", () => {
  it("reads strings as bodies and skips empty steps", () => {
    expect(parseSteps(["Open it.", " ", { title: "Run", code: "npm test\n\n", language: "sh" }, { text: "Done." }, {}, null])).toEqual([
      { title: "", body: "Open it." },
      { title: "Run", body: "", code: "npm test", language: "sh" },
      { title: "", body: "Done.", code: undefined, language: undefined },
    ]);
  });
});

describe("Quiz", () => {
  it("shows right and wrong, then sends the score", async () => {
    const events: ActionEvent[] = [];
    const code = `root = Quiz([{q: "1 + 1?", options: ["1", "2"], answer: "2", why: "Count them."}, {q: "Sky?", options: ["Blue", "Green"], answer: 0}], "Basics", true)`;
    render(<HostContext.Provider value={chat}><Renderer response={code} library={specLibrary} isStreaming={false} onAction={(event) => events.push(event)} /></HostContext.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "1" }));
    expect(screen.getByRole("status").textContent).toBe("Not quite. The answer is 2. Count them.");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: /See score/ }));
    expect(screen.getByRole("status").textContent).toBe("1 of 2 correct");
    fireEvent.click(screen.getByRole("button", { name: "Send score" }));
    expect(events.map((event) => event.humanFriendlyMessage)).toEqual(["Quiz score: 1 of 2 (Basics)"]);
  });
});
