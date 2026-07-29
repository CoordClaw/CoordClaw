import { debug, warn, getEventId } from "../../shared/logger";

let dispatchWindowStart = 0;
let dispatchWindowCount = 0;
const DISPATCH_WINDOW_MS = 60 * 1000;
const MAX_DISPATCHES_PER_WINDOW = 20;

function resetWindowIfNeeded(now: number): void {
  if (dispatchWindowStart === 0 || now - dispatchWindowStart > DISPATCH_WINDOW_MS) {
    dispatchWindowStart = now;
    dispatchWindowCount = 0;
  }
}

export function shouldDispatchNotification(): boolean {
  const now = Date.now();
  resetWindowIfNeeded(now);

  if (dispatchWindowCount >= MAX_DISPATCHES_PER_WINDOW) {
    warn('message-routing', `CIRCUIT BREAKER: ${dispatchWindowCount} dispatches in ${DISPATCH_WINDOW_MS / 1000}s window, stopping all dispatches`, getEventId());
    return false;
  }

  return true;
}

export function recordDispatch(): void {
  const now = Date.now();
  resetWindowIfNeeded(now);
  dispatchWindowCount++;
  debug('message-routing', `recordDispatch: window=${dispatchWindowCount}/${MAX_DISPATCHES_PER_WINDOW}`, getEventId());
}
