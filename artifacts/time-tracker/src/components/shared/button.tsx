/**
 * Shared Button — avanai CI (Step 2 of the redesign).
 * Variants per avatrack-component-library.html: one primary action per view,
 * danger only for destructive/irreversible actions.
 */
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-brand text-white hover:bg-brand/90",
        secondary: "bg-transparent text-navy border-[1.5px] border-navy hover:bg-navy/5",
        ghost: "bg-transparent text-brand hover:bg-brand/10",
        danger: "bg-status-danger text-white hover:bg-status-danger/90",
      },
      size: {
        default: "px-4 py-2",
        sm: "px-3 py-1.5 text-xs rounded-md",
        lg: "px-5 py-2.5",
        icon: "h-8 w-8 rounded-md",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface SharedButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, SharedButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "SharedButton";

export { buttonVariants as sharedButtonVariants };
