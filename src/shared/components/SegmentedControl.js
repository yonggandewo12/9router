"use client";

import { cn } from "@/shared/utils/cn";

/**
 * Segment control (tab/period switcher).
 *
 * `suppressHydrationWarning` on each BUTTON is load-bearing: this lane is a
 * pure-client i18n (src/i18n/runtime.js rewrites text nodes with a
 * MutationObserver), while the server always renders the SOURCE label
 * ("Overview"). A client whose locale cookie is set therefore has the label
 * rewritten to its translation ("概览") before React 19 hydrates, and React
 * then reports a client/server text mismatch on exactly that text node.
 *
 * The attribute goes on the BUTTON, not the wrapper div: React's hydration
 * check for a host element's text skips that element's DIRECT text children
 * (react-dom hydrate: `!0 === props.suppressHydrationWarning ||
 * checkForUnmatchedText(...)`), and the label text is a direct child of the
 * button, not of the wrapper. Opting the button out lets the rewrite happen
 * without the warning; React re-renders the same labels on its next commit,
 * which the observer then re-translates idempotently (node._originalText).
 */
export default function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "md",
  className,
}) {
  const sizes = {
    sm: "h-7 text-xs",
    md: "h-9 text-sm",
    lg: "h-11 text-base",
  };

  return (
    <div
      className={cn(
        "inline-flex items-center p-1 rounded-[10px] overflow-x-auto",
        "bg-surface-2",
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          suppressHydrationWarning
          onClick={() => onChange(option.value)}
          className={cn(
            "shrink-0 px-4 rounded-[8px] font-medium transition-all",
            sizes[size],
            value === option.value
              ? "bg-surface text-text-main shadow-sm"
              : "text-text-muted hover:text-text-main"
          )}
        >
          {option.icon && (
            <span className="material-symbols-outlined text-[16px] mr-1.5">
              {option.icon}
            </span>
          )}
          {option.label}
        </button>
      ))}
    </div>
  );
}
