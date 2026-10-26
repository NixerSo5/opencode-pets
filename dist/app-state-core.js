export const defaultWaitingAnimationDurationMs = 1010;
export const waitingAnimationDurationOptions = [1010, 2200];
export function normalizeWaitingAnimationDurationMs(value) {
    return value === 2200 ? 2200 : 1010;
}
