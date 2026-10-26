export declare const defaultWaitingAnimationDurationMs = 1010;
export declare const waitingAnimationDurationOptions: readonly [1010, 2200];
export type WaitingAnimationDurationMs = typeof waitingAnimationDurationOptions[number];
export declare function normalizeWaitingAnimationDurationMs(value: unknown): WaitingAnimationDurationMs;
