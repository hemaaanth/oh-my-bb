// How the pet looks (SPEC §7.3). The look is a server preference that arrives
// with `preferencesRead` and `preferences-updated`; this file only cleans it.

import type { PetLook } from "@/shared/contract.js";
import { defaultPreferences } from "@/shared/constants.js";

export type { PetLook };
export type PetStyle = PetLook["style"];

export const PET_STYLES: readonly PetStyle[] = ["outline", "solid"];
/** Follow the sidebar icon color instead of a fixed color. */
export const PET_THEME_COLOR = "theme";
export const DEFAULT_PET_LOOK: PetLook = defaultPreferences().pet;

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export function normalizePetLook(value: unknown): PetLook {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const color = typeof raw.color === "string" ? raw.color.trim().toLowerCase() : "";
  const roundness = typeof raw.roundness === "number" && Number.isFinite(raw.roundness)
    ? Math.round(Math.min(100, Math.max(0, raw.roundness)))
    : DEFAULT_PET_LOOK.roundness;
  return {
    style: PET_STYLES.includes(raw.style as PetStyle) ? (raw.style as PetStyle) : DEFAULT_PET_LOOK.style,
    color: HEX_COLOR.test(color) ? color : PET_THEME_COLOR,
    roundness,
    followPointer: typeof raw.followPointer === "boolean" ? raw.followPointer : DEFAULT_PET_LOOK.followPointer,
    antennaFlash: typeof raw.antennaFlash === "boolean" ? raw.antennaFlash : DEFAULT_PET_LOOK.antennaFlash,
  };
}
