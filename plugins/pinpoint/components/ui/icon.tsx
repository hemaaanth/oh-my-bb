import { experimental_Icon as HostIcon } from "@get-bb/plugin-sdk/app";
import type { ComponentProps } from "react";

// Resolve through BB so app-wide icon overrides also apply to this plugin.
const ICON_MAP = {
  "ArrowRight": "ArrowRight",
  "Camera": "pinpoint/camera",
  "CameraOff": "pinpoint/camera-off",
  "ChatFeedback": "pinpoint/chat-feedback",
  "Agent": "pinpoint/agent",
  "CheckCircle": "pinpoint/check-circle",
  "Check": "Check",
  "ChevronLeft": "ChevronLeft",
  "ChevronRight": "ChevronRight",
  "Eye": "Eye",
  "EyeOff": "EyeOff",
  "Guests": "pinpoint/guests",
  "Edit": "Edit",
  "Pin": "Pin",
  "PinOff": "PinOff",
  "RotateCcw": "RotateCcw",
  "Settings": "Settings",
  "Trash2": "Trash2",
  "User": "pinpoint/user",
  "X": "X",
} as const;

export type IconName = keyof typeof ICON_MAP;
export const ICON_NAMES = Object.keys(ICON_MAP) as readonly IconName[];
export type IconProps = Omit<ComponentProps<typeof HostIcon>, "name"> & { name: IconName };

export function Icon({ name, ...props }: IconProps) {
  return <HostIcon {...props} name={ICON_MAP[name]} />;
}
