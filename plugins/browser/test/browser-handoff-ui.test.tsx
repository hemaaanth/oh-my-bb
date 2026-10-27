// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);
function render(instructions: unknown, submit = vi.fn(async (_value: unknown) => undefined),extra:Record<string,unknown>={}) {
  const slot = renderSlot(app.pendingInteractions.find(entry => entry.id === "browser-handoff")!, {
    interaction:{threadId:"thr_browser", payload:{instructions, host:"My desktop",...extra}}, submit, cancel:async () => undefined,
  } as never);
  return {slot, submit};
}
it("keeps the action and answers compact, with full instructions only in Details", async () => {
  const instructions = "Sign in to Hostinger. Open the VPS dashboard, then click Done. Do not purchase anything.";
  const {slot, submit} = render(instructions);
  expect(slot.getByText("Sign in to Hostinger.")).toBeTruthy();
  expect(slot.getByText(instructions).closest("details")!.open).toBe(false);
  expect(slot.queryByText(/Automation is paused/)).toBeNull();
  expect(slot.queryByRole("button", {name:"Open browser"})).toBeNull();
  const details = slot.getByText("Details").closest("summary")!;
  expect(details.closest("details")!.open).toBe(false);
  fireEvent.click(details);
  expect(slot.getByText(instructions)).toBeTruthy();
  expect(slot.getByText(/Browser paused · My desktop/)).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(details);
  expect(slot.getByText(instructions).closest("details")!.open).toBe(false);
  fireEvent.click(slot.getByRole("button", {name:"Done"}));
  await waitFor(() => expect(submit).toHaveBeenCalledWith({done:true}));
});
it("bounds legacy paragraphs while keeping the original details available", () => {
  const instructions = "Sign in " + "to the right account ".repeat(30);
  const {slot} = render(instructions);
  const summary = slot.container.querySelector("p")!;
  expect(summary.textContent!.length).toBeLessThanOrEqual(100);
  expect(summary.className).toContain("truncate");
  fireEvent.click(slot.getByText("Details").closest("summary")!);
  expect(slot.getByText(instructions.trim())).toBeTruthy();
});
it("uses a short retry message, allows cancellation and never displays raw errors", async () => {
  const submit = vi.fn().mockRejectedValueOnce(new Error("Raw transport diagnostics")).mockResolvedValueOnce(undefined);
  const {slot} = render(null, submit);
  fireEvent.click(slot.getByRole("button", {name:"Done"}));
  expect(await slot.findByRole("alert")).toHaveProperty("textContent", "Couldn’t save your answer. Try again.");
  expect(slot.queryByText(/Raw transport/)).toBeNull();
  fireEvent.click(slot.getByRole("button", {name:"Cancel"}));
  await waitFor(() => expect(submit).toHaveBeenLastCalledWith({done:false}));
});

it('embeds only sandbox handoffs and retains external opening',()=>{
 const {slot}=render('Sign in.',undefined,{inlineViewer:true,viewerUrl:'https://sandbox--1234.getbb.app/#grant'});
 const frame=slot.getByTitle('Browser session');expect(frame.getAttribute('src')).toBe('https://sandbox--1234.getbb.app/#grant');expect(frame.getAttribute('allow')).toBe('fullscreen');expect(slot.getByRole('link',{name:'Open session'})).toBeTruthy();
});
it('does not embed local handoff viewers',()=>{
 const {slot}=render('Sign in.',undefined,{inlineViewer:false,viewerUrl:'https://server.getbb.app/viewer'});expect(slot.queryByTitle('Browser session')).toBeNull();
});

it("returns a comment without marking the action done, retaining the draft after a failed send", async () => {
  const submit = vi.fn().mockRejectedValueOnce(Error("transport")).mockResolvedValue(undefined);
  const { slot } = render("Sign in.", submit);
  fireEvent.click(slot.getByRole("button", { name: "Reply to agent" }));
  const input = slot.getByRole("textbox", { name: "Reply to agent" });
  const send = slot.getByRole("button", { name: "Send reply" });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "Try the other account instead." } });
  fireEvent.click(send);
  await slot.findByRole("alert");
  expect((input as HTMLTextAreaElement).value).toBe("Try the other account instead.");
  fireEvent.click(send);
  await waitFor(() => expect(submit).toHaveBeenLastCalledWith({ reply: "Try the other account instead." }));
  expect(submit.mock.calls.some(([value]) => value?.done === true)).toBe(false);
});
