import { experimental_Icon as HostIcon, type ExperimentalIconProps } from "@get-bb/plugin-sdk/app";

export type IconName = "Check" | "ChevronDown" | "CircleX" | "Copy" | "ExternalLink" | "Info" | "Loading";
export type IconProps = Omit<ExperimentalIconProps, "name"> & { name: IconName };
export function Icon({ name, ...props }: IconProps) {
  return <HostIcon aria-hidden={props["aria-label"] ? undefined : true} {...props} name={name} />;
}
