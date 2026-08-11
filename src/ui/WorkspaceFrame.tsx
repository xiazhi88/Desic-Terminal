import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";

export type WorkspaceTone = "research" | "intelligence" | "automation";

type WorkspaceFrameProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  tone: WorkspaceTone;
};

/**
 * Shared host for non-trading workspaces. It owns only the surrounding surface;
 * individual pages retain their domain-specific navigation and data contracts.
 */
export const WorkspaceFrame = forwardRef<HTMLDivElement, WorkspaceFrameProps>(function WorkspaceFrame(
  { children, className, tone, ...props },
  ref
) {
  return (
    <div ref={ref} className={clsx("workspace-surface", `workspace-surface--${tone}`, className)} {...props}>
      {children}
    </div>
  );
});

WorkspaceFrame.displayName = "WorkspaceFrame";
