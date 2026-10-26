import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "Check"
  | "ChevronDown"
  | "CircleX"
  | "Copy"
  | "ExternalLink"
  | "Info"
  | "Loading";

function artwork(name: IconName): ReactNode {
  switch (name) {
    case "Check":
      return <path d="m5 12 4 4L19 6" />;
    case "ChevronDown":
      return <path d="m6 9 6 6 6-6" />;
    case "CircleX":
      return <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>;
    case "Copy":
      return <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>;
    case "ExternalLink":
      return <><path d="M14 5h5v5M19 5l-9 9" /><path d="M19 14v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3" /></>;
    case "Info":
      return <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>;
    case "Loading":
      return <path d="M21 12a9 9 0 1 1-2.64-6.36" />;
  }
}

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
}

export function Icon({ name, ...props }: IconProps) {
  return (
    <svg
      aria-hidden={props["aria-label"] ? undefined : true}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
      {...props}
    >
      {artwork(name)}
    </svg>
  );
}
