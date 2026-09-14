/**
 * Navigation, without a router.
 *
 * A library cannot move between screens with a router. It does not own the URL,
 * it does not know whether the host has a router at all, and pushing a history
 * entry from inside a component embedded in somebody else's page is a good way
 * to break their back button.
 *
 * So the flow is a graph held in component state, and its two outward edges are
 * callbacks to the host:
 *
 *   "capture"        the viewfinder, and corner confirmation
 *   "review"         the page list
 *   "build"          file name, size, "Gerar PDF"
 *   onComplete()     the PDF exists; the host takes it from here
 *   onCancel("user") leaving the flow backwards; the host decides
 *                    whether that closes anything
 *
 * `onCancel` is a request, not an announcement: the library never unmounts
 * itself, because the host owns the dialog and may want to ask "discard these
 * pages?" first. If the host ignores it, the flow simply stays where it is —
 * and stays *working*: a user cancel does not latch anything, so the next tap
 * navigates, and the next close request reaches the host again.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
    useState,
  type ReactNode,
} from "react";
import type { ScanCancelReason, ScanStep } from "@/types";

export interface FlowNavigation {
  /** Where the flow is now. */
  readonly step: ScanStep;
  /** Move to a step. A no-op once the flow has completed or failed. */
  go(step: ScanStep): void;
  /**
   * The backwards edge, with the host's exit at the end of it.
   *
   * `build → review → capture → (host)`. The caller passes what it knows about
   * whether there is anything to go back to; the screens already compute that.
   */
  back(): void;
  /**
   * Ask the host to close. Never latches for `"user"`: the host may refuse.
   * A double tap inside one gesture is absorbed by the flow's exit gate
   * (`lib/exit-gate.ts`), so a person mashing a back button does not produce
   * five cancel events.
   */
  requestCancel(reason: ScanCancelReason): void;
}

const FlowNavigationContext = createContext<FlowNavigation | null>(null);

export interface FlowNavigationProviderProps {
  children: ReactNode;
  /** Called when the flow would leave through its own entrance. */
  onExit(reason: ScanCancelReason): void;
  /** Reported on every step change, for the host's telemetry. */
  onStep?(step: ScanStep): void;
  /**
   * True once the flow has completed or failed. Late taps on a lingering
   * control must not move a flow that is over — the host may keep this
   * component mounted while its own dialog animates away.
   */
  isFinished?(): boolean;
  initialStep?: ScanStep;
}

/** The backwards edge of the graph. `capture` has no predecessor: it exits. */
const PREDECESSOR: Record<ScanStep, ScanStep | null> = {
  capture: null,
  corners: "capture",
  review: "capture",
  build: "review",
};

export function FlowNavigationProvider({
  children,
  onExit,
  onStep,
  isFinished,
  initialStep = "capture",
}: FlowNavigationProviderProps) {
  const [step, setStep] = useState<ScanStep>(initialStep);

  const closed = useCallback(() => isFinished?.() === true, [isFinished]);

  const go = useCallback(
    (next: ScanStep) => {
      if (closed()) return;
      setStep((current) => {
        if (current === next) return current;
        onStep?.(next);
        return next;
      });
    },
    [closed, onStep]
  );

  const requestCancel = useCallback(
    (reason: ScanCancelReason) => {
      if (closed()) return;
      onExit(reason);
    },
    [closed, onExit]
  );

  const back = useCallback(() => {
    if (closed()) return;
    const previous = PREDECESSOR[step];
    if (previous === null) {
      requestCancel("user");
      return;
    }
    go(previous);
  }, [go, requestCancel, step]);

  const value = useMemo<FlowNavigation>(
    () => ({ step, go, back, requestCancel }),
    [step, go, back, requestCancel]
  );

  return (
    <FlowNavigationContext.Provider value={value}>{children}</FlowNavigationContext.Provider>
  );
}

export function useFlowNavigation(): FlowNavigation {
  const value = useContext(FlowNavigationContext);
  if (value === null) {
    throw new Error(
      "useFlowNavigation was called outside <ScanFlow>. Every screen in this " +
        "library runs inside the flow; if you are rendering one directly, wrap it " +
        "in FlowNavigationProvider."
    );
  }
  return value;
}
