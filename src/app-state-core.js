export const petScaleOptions = [
    { label: "XS", value: 0.35 },
    { label: "Small", value: 0.5 },
    { label: "Medium", value: 0.75 },
    { label: "Large", value: 1 },
    { label: "Huge", value: 1.25 },
];
export const defaultPetScale = 0.75;
/** The retired 1.5 "Huge" maps to the largest current size instead of resetting to default. */
const retiredLargestPetScale = 1.5;
// Scale for the pinned plugin bubble (the HUD under the pet). Deliberately a
// separate preference from petScale: pet size is aesthetic, HUD size is about
// readability.
export const hudScaleOptions = [
    { label: "XS", value: 0.85 },
    { label: "Small", value: 1.1 },
    { label: "Medium", value: 1.4 },
    { label: "Large", value: 1.7 },
    { label: "Huge", value: 2 },
];
export const defaultHudScale = 1.1;
export function getHudScaleForPetScale(petScale) {
    switch (petScale) {
        case 0.35:
        case 0.5:
            return 0.85;
        case 0.75:
            return 1.1;
        case 1:
            return 1.4;
        case 1.25:
            return 1.7;
        default:
            return normalizeHudScale(petScale);
    }
}
export const defaultPetButtonsPosition = "right";
export function normalizePetButtonsPosition(value) {
    return value === "left" || value === "right" ? value : defaultPetButtonsPosition;
}
export const defaultPetButtonsSize = "medium";
export function normalizePetButtonsSize(value) {
    return value === "small" || value === "medium" || value === "large" ? value : defaultPetButtonsSize;
}
export const waitingAnimationDurationOptions = [
    { value: 1010, label: "Normal" },
    { value: 2200, label: "Relaxed" },
];
export const defaultWaitingAnimationDurationMs = waitingAnimationDurationOptions[0].value;
/** Whether idle V2 pets follow the global cursor by default. */
export const defaultIdleCursorGazeEnabled = true;
export function normalizeIdleCursorGazeEnabled(value, defaultValue = defaultIdleCursorGazeEnabled) {
    return typeof value === "boolean" ? value : defaultValue;
}
export const appearanceThemeOptions = ["system", "light", "dark"];
export const defaultAppearanceTheme = "system";
export function normalizeAppearanceTheme(value) {
    return appearanceThemeOptions.find((option) => option === value) ?? defaultAppearanceTheme;
}
export function normalizeWaitingAnimationDurationMs(value) {
    return waitingAnimationDurationOptions.find((option) => option.value === value)?.value ?? defaultWaitingAnimationDurationMs;
}
export function normalizePetScale(value) {
    if (value === retiredLargestPetScale)
        return 1.25;
    return petScaleOptions.find((option) => option.value === value)?.value ?? defaultPetScale;
}
export function normalizeHudScale(value) {
    return hudScaleOptions.find((option) => option.value === value)?.value ?? defaultHudScale;
}
export function normalizeOnboardingCompleted(value) {
    return typeof value.onboardingCompleted === "boolean" ? value.onboardingCompleted : false;
}
export function markOnboardingCompleted(state) {
    return {
        ...state,
        preferences: {
            ...state.preferences,
            onboardingCompleted: true,
        },
    };
}
/**
 * Derive a stable string key for a display from its geometry.
 * Format: `"${x},${y},${width}x${height}"`.
 * Display IDs can change across reboots on some platforms, so we key on
 * physical bounds instead.
 */
export function deriveDisplayKey(bounds) {
    return `${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`;
}
export function shouldShowDefaultPetForExternalEvent(_visible, _openOnLaunch, paused) {
    // Agent activity is an explicit display trigger; open-on-launch only controls startup.
    return !paused;
}
/**
 * Normalize the petConfinementEnabled preference value.
 * Default is true (confinement on). Non-boolean values fall back to the default.
 */
export function normalizePetConfinementEnabled(value, defaultValue = true) {
    return typeof value === "boolean" ? value : defaultValue;
}
/**
 * Normalize the petCrossDisplayEnabled preference value.
 * Default is false (cross-display roaming off). Non-boolean values fall back to the default.
 */
export function normalizePetCrossDisplayEnabled(value, defaultValue = false) {
    return typeof value === "boolean" ? value : defaultValue;
}
/**
 * Normalize the petGravityEnabled preference value.
 * Default is false (gravity off). Non-boolean values fall back to the default.
 */
export function normalizePetGravityEnabled(value, defaultValue = false) {
    return typeof value === "boolean" ? value : defaultValue;
}
export const defaultPetBounciness = 0.5;
export const defaultPetFloorFriction = 0.3;
/**
 * Normalize a 0–1 pet physics preference (bounciness, floor friction).
 * Non-finite or non-number values fall back to the default; out-of-range values are clamped.
 */
export function normalizePetPhysicsFraction(value, defaultValue) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return defaultValue;
    return Math.min(Math.max(value, 0), 1);
}
const safePetIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function isSafeFlipPetId(petId) {
    return safePetIdPattern.test(petId);
}
/**
 * Normalize per-pet horizontal flip preferences.
 * Only `true` values for valid pet IDs are retained; false is the default and is omitted.
 */
export function normalizePetHorizontalFlip(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const normalized = {};
    for (const [key, rawVal] of Object.entries(value)) {
        if (!isSafeFlipPetId(key) || rawVal !== true)
            continue;
        normalized[key] = true;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
/**
 * Toggle one pet's horizontal flip without affecting other pets.
 * Returns the next persisted map, or undefined when no pets remain flipped.
 */
export function togglePetHorizontalFlipMap(current, petId) {
    if (!isSafeFlipPetId(petId)) {
        throw new Error(`Invalid pet id for horizontal flip: ${petId}`);
    }
    const next = { ...(normalizePetHorizontalFlip(current) ?? {}) };
    if (next[petId])
        delete next[petId];
    else
        next[petId] = true;
    return normalizePetHorizontalFlip(next);
}
