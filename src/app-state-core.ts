export const defaultWaitingAnimationDurationMs = 1010;
export const waitingAnimationDurationOptions = [1010, 2200] as const;
export type WaitingAnimationDurationMs = typeof waitingAnimationDurationOptions[number];
export function normalizeWaitingAnimationDurationMs(value: unknown): WaitingAnimationDurationMs {
  return value === 2200 ? 2200 : 1010;
}
