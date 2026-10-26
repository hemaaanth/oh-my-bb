import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-foreground text-background hover:bg-foreground/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-transparent hover:bg-state-hover hover:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-state-hover hover:text-foreground aria-pressed:bg-state-active aria-pressed:text-foreground aria-pressed:hover:bg-state-active data-[state=open]:bg-state-active data-[state=open]:text-foreground data-[state=open]:hover:bg-state-active",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "title"
> &
  VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  const pluginId = experimental_usePluginId();
  const label = props["aria-label"];
  const button = (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
  if (!label || size !== "icon") return button;
  return <TooltipPrimitive.Provider delayDuration={400}>
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{button}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content data-bb-plugin={pluginId} data-bb-plugin-root="" data-bb-portaled-overlay=""
          sideOffset={4} className="z-[90] rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm">
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>;
}

export { Button };
