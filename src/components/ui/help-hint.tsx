/**
 * HelpHint — tiny "(?)" icon next to a label that reveals contextual help.
 *
 * Usage:
 *   <Label>Source collection <HelpHint text="The reference image set used as the alignment baseline." /></Label>
 *
 * - Default: Tooltip on hover/focus (≤1 short sentence).
 * - Set `popover` when you need richer content (heading + paragraph + list).
 *
 * Convention: place AFTER the label, never before. Always provide aria-label
 * so screen readers announce it.
 */
import * as React from "react";
import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface HelpHintProps {
  /** Short text — used for tooltip and as fallback aria-label. */
  text?: string;
  /** Rich content — when provided, renders inside a Popover instead of a Tooltip. */
  children?: React.ReactNode;
  /** Force popover mode even with text-only content. */
  popover?: boolean;
  /** Visual size — default 'sm' (label-adjacent). 'md' for headings. */
  size?: "sm" | "md";
  className?: string;
  /** Optional label override for screen readers. */
  ariaLabel?: string;
}

export function HelpHint({
  text,
  children,
  popover,
  size = "sm",
  className,
  ariaLabel,
}: HelpHintProps) {
  const iconClass = size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";
  const usePopover = popover || !!children;

  const trigger = (
    <button
      type="button"
      aria-label={ariaLabel || (typeof text === "string" ? `Help: ${text}` : "Help")}
      className={cn(
        "inline-flex shrink-0 items-center justify-center align-middle ml-1 text-muted-foreground hover:text-foreground focus:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full",
        className,
      )}
      onClick={(e) => {
        // Prevent label click from toggling its associated control
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <HelpCircle className={iconClass} />
    </button>
  );

  if (usePopover) {
    return (
      <Popover>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent side="top" className="max-w-xs text-xs leading-relaxed">
          {children ?? text}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
