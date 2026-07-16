/**
 * SharedTooltip — navy tooltip for exact labels behind compact chips and
 * dense identifiers (client, rate, dates). Thin wrapper over Radix.
 * The app-level <TooltipProvider> in App.tsx already applies.
 */
import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export interface SharedTooltipProps {
  /** Tooltip content; when null/undefined the child renders bare. */
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
  /** Delay in ms before showing (default 150). */
  delayDuration?: number;
}

export function SharedTooltip({
  content,
  children,
  side = "top",
  align = "center",
  className,
  delayDuration = 150,
}: SharedTooltipProps) {
  if (content == null || content === "") return <>{children}</>;
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            "z-50 max-w-[280px] rounded-md bg-navy px-2.5 py-1.5 text-xs leading-snug text-white shadow-md",
            "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            className,
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-navy" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
