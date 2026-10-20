// Test fixtures for the settings and console tests. Not shipped: nothing in the
// app imports this file, so the build leaves it out.
import { defaultPreferences, SECRET_IDS } from "../../shared/constants.js";
import type { Preferences, SetupStatus } from "../../shared/contract.js";
import { fireEvent, screen } from "@testing-library/react";

// Radix scrolls the active item into view. jsdom has no layout implementation.
HTMLElement.prototype.scrollIntoView ??= () => {};

export async function openSetting(label: string): Promise<void> {
  fireEvent.keyDown(await screen.findByRole("combobox", { name: label }), { key: "ArrowDown" });
}

export async function chooseSetting(label: string, option: string): Promise<void> {
  await openSetting(label);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/** Node's experimental global localStorage shadows jsdom's and is unusable without a file. */
export function installFakeLocalStorage(): Record<string, string> {
  const stored: Record<string, string> = {};
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => {
        stored[key] = value;
      },
      removeItem: (key: string) => {
        delete stored[key];
      },
      clear: () => {
        for (const key of Object.keys(stored)) delete stored[key];
      },
    },
  });
  return stored;
}

export const makeStatus = (over: Partial<SetupStatus> = {}): SetupStatus => ({
  fields: Object.fromEntries(SECRET_IDS.map((id) => [id, false])) as SetupStatus["fields"],
  voice: { ready: false, missing: ["In-app voice — OpenAI API key"] },
  phone: { ready: false, missing: ["Phone calls — Twilio Account SID"], webhooksPlugin: "absent" },
  needsConfiguration: true,
  reloadPending: false,
  version: "0.1.0",
  ...over,
});

/** A preferences store with the same shallow-merge a real write does. */
export function makePrefsRpc(initial: Partial<Preferences> = {}) {
  let current: Preferences = { ...defaultPreferences(), ...initial };
  const writes: Array<Partial<Preferences>> = [];
  return {
    get current() {
      return current;
    },
    writes,
    handlers: {
      preferencesRead: async () => current,
      preferencesWrite: async (patch: Partial<Preferences>) => {
        writes.push(patch);
        current = { ...current, ...patch };
        return current;
      },
      preferencesReset: async () => {
        current = defaultPreferences();
        return current;
      },
    },
  };
}
