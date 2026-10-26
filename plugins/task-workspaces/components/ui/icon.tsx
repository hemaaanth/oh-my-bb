import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  AlertCircleIcon,
  Archive03Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  AttachmentIcon,
  BubbleChatAddIcon,
  BubbleChatIcon,
  Calendar03Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Clock01Icon,
  ComputerTerminal01Icon,
  DashedLineCircleIcon,
  Delete02Icon,
  DragDropVerticalIcon,
  Edit02Icon,
  ViewIcon,
  ViewOffIcon,
  FolderIcon,
  GitBranchIcon,
  GitMergeIcon,
  GridViewIcon,
  HelpCircleIcon,
  LaptopIcon,
  Layers01Icon,
  ListViewIcon,
  Loading03Icon,
  LinkSquare02Icon,
  Mail02Icon,
  MailOpen01Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
  PrinterIcon,
  Refresh01Icon,
  RepeatIcon,
  Search01Icon,
  TaskAdd01Icon,
  Settings01Icon,
  SlidersHorizontalIcon,
  Tick02Icon,
  Unlink01Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "../../lib/utils";

// The free hugeicons set ships no artist-palette glyph (its `Palette` export
// is a pen nib), so this inlines the stroke-rounded palette artwork in the
// same element format the set uses.
const PaletteStrokeRoundedIcon: IconSvgElement = [
  [
    "path",
    {
      d: "M21.8205 10.4127C22.062 11.8519 22.1827 12.5715 21.2423 13.9326C21.1459 14.0722 20.8966 14.3713 20.777 14.4911C19.6103 15.6586 18.4308 15.6586 16.0716 15.6586H14.1392C13.5085 15.6586 13.1931 15.6586 12.9639 15.7142C11.9586 15.9581 11.3031 16.9391 11.453 17.9755C11.4872 18.2118 11.6043 18.5085 11.8386 19.102C11.9345 19.3449 11.9824 19.4664 12.0136 19.7304C12.1292 20.7084 11.0869 21.9508 10.1158 21.9926C9.85358 22.0039 9.83681 22.0002 9.80326 21.9926C7.66174 21.51 5.66204 20.3123 4.18389 18.4421C0.736789 14.0808 1.43146 7.71364 5.73548 4.22064C10.0395 0.727643 16.323 1.43156 19.7701 5.79289C20.868 7.1819 21.5457 8.77438 21.8205 10.4127Z",
      fill: "none",
      fillRule: "evenodd",
      clipRule: "evenodd",
      stroke: "currentColor",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "0",
    },
  ],
  [
    "path",
    {
      d: "M7.36719 7.74976H7.24219M7.49219 7.74976C7.49219 7.88783 7.38026 7.99976 7.24219 7.99976C7.10412 7.99976 6.99219 7.88783 6.99219 7.74976C6.99219 7.61169 7.10412 7.49976 7.24219 7.49976C7.38026 7.49976 7.49219 7.61169 7.49219 7.74976Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "1",
    },
  ],
  [
    "path",
    {
      d: "M7.36719 15.7498H7.24219M7.49219 15.7498C7.49219 15.8878 7.38026 15.9998 7.24219 15.9998C7.10412 15.9998 6.99219 15.8878 6.99219 15.7498C6.99219 15.6117 7.10412 15.4998 7.24219 15.4998C7.38026 15.4998 7.49219 15.6117 7.49219 15.7498Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "2",
    },
  ],
  [
    "path",
    {
      d: "M11.8672 5.74976H11.7422M11.9922 5.74976C11.9922 5.88783 11.8803 5.99976 11.7422 5.99976C11.6041 5.99976 11.4922 5.88783 11.4922 5.74976C11.4922 5.61169 11.6041 5.49976 11.7422 5.49976C11.8803 5.49976 11.9922 5.61169 11.9922 5.74976Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "3",
    },
  ],
  [
    "path",
    {
      d: "M16.3672 7.74976H16.2422M16.4922 7.74976C16.4922 7.88783 16.3803 7.99976 16.2422 7.99976C16.1041 7.99976 15.9922 7.88783 15.9922 7.74976C15.9922 7.61169 16.1041 7.49976 16.2422 7.49976C16.3803 7.49976 16.4922 7.61169 16.4922 7.74976Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "4",
    },
  ],
  [
    "path",
    {
      d: "M18.3672 11.7498H18.2422M18.4922 11.7498C18.4922 11.8878 18.3803 11.9998 18.2422 11.9998C18.1041 11.9998 17.9922 11.8878 17.9922 11.7498C17.9922 11.6117 18.1041 11.4998 18.2422 11.4998C18.3803 11.4998 18.4922 11.6117 18.4922 11.7498Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "5",
    },
  ],
  [
    "path",
    {
      d: "M5.86719 11.7498H5.74219M5.99219 11.7498C5.99219 11.8878 5.88026 11.9998 5.74219 11.9998C5.60412 11.9998 5.49219 11.8878 5.49219 11.7498C5.49219 11.6117 5.60412 11.4998 5.74219 11.4998C5.88026 11.4998 5.99219 11.6117 5.99219 11.7498Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "6",
    },
  ],
];

// Only the glyphs this plugin renders ship in the bundle: every entry is SVG
// path data parsed at startup. Add a name here before using it.
const ICON_MAP = {
  AlertCircle: AlertCircleIcon,
  AlertTriangle: Alert02Icon,
  Archive: Archive03Icon,
  ArrowUp: ArrowUp02Icon,
  Calendar: Calendar03Icon,
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronRight: ArrowRight01Icon,
  ChevronUp: ArrowUp01Icon,
  Circle: CircleIcon,
  CircleCheck: CheckmarkCircle02Icon,
  CircleDashed: DashedLineCircleIcon,
  CircleQuestion: HelpCircleIcon,
  CircleX: CancelCircleIcon,
  Clock: Clock01Icon,
  ComputerTerminal01: ComputerTerminal01Icon,
  DragDropVertical: DragDropVerticalIcon,
  Edit: Edit02Icon,
  Eye: ViewIcon,
  EyeOff: ViewOffIcon,
  ExternalLink: LinkSquare02Icon,
  Folder: FolderIcon,
  GitBranch: GitBranchIcon,
  GitMerge: GitMergeIcon,
  GridView: GridViewIcon,
  Laptop: LaptopIcon,
  Layers: Layers01Icon,
  ListView: ListViewIcon,
  ListTodo: CheckListIcon,
  Loading: Loading03Icon,
  Mail: Mail02Icon,
  MailOpen: MailOpen01Icon,
  MessageSquarePlus: BubbleChatAddIcon,
  MessageSquare: BubbleChatIcon,
  MoreHorizontal: MoreHorizontalIcon,
  Palette: PaletteStrokeRoundedIcon,
  Paperclip: AttachmentIcon,
  Plus: PlusSignIcon,
  Printer: PrinterIcon,
  Repeat: RepeatIcon,
  RotateCcw: Refresh01Icon,
  Search: Search01Icon,
  Settings: Settings01Icon,
  SlidersHorizontal: SlidersHorizontalIcon,
  TaskAdd: TaskAdd01Icon,
  Trash2: Delete02Icon,
  Unlink: Unlink01Icon,
  UserRound: UserIcon,
  X: Cancel01Icon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof ICON_MAP;

export const ICON_NAMES = Object.keys(ICON_MAP) as readonly IconName[];

export interface IconProps {
  name: IconName;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export function Icon({
  name,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  return (
    <HugeiconsIcon
      icon={ICON_MAP[name]}
      className={cn(className)}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={name}
    />
  );
}
