/**
 * SearchInput — standard search field, standalone or inside filter/picker panels.
 */
import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Show a clear (×) button when there is text. Default true. */
  clearable?: boolean;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ value, onValueChange, clearable = true, className, placeholder = "Search…", ...props }, ref) => {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-border-soft bg-card px-3 py-2",
          "focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15",
          className,
        )}
      >
        <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={ref}
          type="text"
          role="searchbox"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onValueChange(e.target.value)}
          className="w-full border-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground [&:focus-visible]:!shadow-none [&:focus-visible]:!border-none"
          {...props}
        />
        {clearable && value && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onValueChange("")}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-bg-soft hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";
