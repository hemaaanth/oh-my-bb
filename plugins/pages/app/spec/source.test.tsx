// @vitest-environment jsdom
/// <reference lib="es2024.promise" />
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Renderer } from "@openuidev/react-lang";
import { afterEach, describe, expect, it } from "vitest";
import { specLibrary } from "./catalog.js";
import { annotateSources, sourcedQuery } from "./source-metadata.js";
import { fixtureTools } from "./kit.js";

afterEach(cleanup);

describe("data source captions", () => {
  it("keeps the file caption with a bound Query path when its table changes", async () => {
    const code = '$pick = 0\nreport = Query("file", {path: $pick == 0 ? "first.json" : "second.json"}, {rows: []})\nroot = Stack([Slider("pick", 0, 1, 1, "Report", $pick), Table(["Name", "Count"], report.rows)])';
    const files: Record<string, { rows: (string | number)[][] }> = { "first.json": { rows: [["First", 11]] }, "second.json": { rows: [["Second", 27]] } };
    const { promise: pending, resolve: completeSecond } = Promise.withResolvers<void>();
    render(<Renderer response={code} library={specLibrary} isStreaming={false} onParseResult={annotateSources} toolProvider={{ file: async (args) => {
      if (args.path === "second.json") await pending;
      return sourcedQuery("file", args, files[String(args.path)]);
    } }} />);
    expect(await screen.findByText("First")).toBeTruthy();
    expect(screen.getByText("first.json")).toBeTruthy();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } });
    expect(screen.queryByText("second.json")).toBeNull();
    await act(async () => completeSecond());
    expect(await screen.findByText("Second")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("first.json")).toBeNull());
    expect(screen.getByText("second.json")).toBeTruthy();
    expect(screen.getByText("27")).toBeTruthy();
  });

  it("credits a derived headline number, not just the original Query object", async () => {
    render(<Renderer response={'report = Query("file", {path: "counts.json"}, {data: {total: 0}})\ntotal = report.data.total * 2\nroot = Stat("Total", total)'} library={specLibrary} isStreaming={false} onParseResult={annotateSources} toolProvider={fixtureTools({ file: { data: { total: 7 } } })} />);
    expect(await screen.findByText("14")).toBeTruthy();
    expect(screen.getByText("counts.json")).toBeTruthy();
  });

  it("lets an explicit empty source suppress automatic credit", async () => {
    render(<Renderer response={'report = Query("file", {path: "counts.json"}, {rows: []})\nroot = Table(["Count"], report.rows, "")'} library={specLibrary} isStreaming={false} onParseResult={annotateSources} toolProvider={fixtureTools({ file: { rows: [[7]] } })} />);
    expect(await screen.findByText("7")).toBeTruthy();
    expect(screen.queryByText("counts.json")).toBeNull();
    expect(screen.queryByText(/Source:/u)).toBeNull();
  });
});
