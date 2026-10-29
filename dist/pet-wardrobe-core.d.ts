/**
 * pet-wardrobe-core.ts
 *
 * Pure wardrobe (outfit) contract for the standalone pet, mirroring the
 * original `pet-wardrobe-core.ts` semantics: outfit validation rules, schedule
 * rule parsing, and the preference-ordered outfit resolution
 * (always-wear > user schedule > creator schedule > default).
 *
 * No Electron / filesystem / pet-store imports: this must stay testable and
 * deterministic down to the `date` passed by the caller.
 */
export type WardobeDay = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export declare const wardrobeDays: readonly WardobeDay[];
export declare const defaultOutfitId = "default";
/** Preference value meaning "ignore any fixed choice, follow the schedule". */
export declare const autoOutfitId = "auto";
export interface WardrobeOutfit {
    readonly id: string;
    readonly displayName: string;
    /** Always `outfits/<id>.webp|svg` relative to the pet folder. */
    readonly spritesheetPath: string;
}
export interface WardrobeTime {
    readonly from: string;
    readonly to: string;
}
export interface WardrobeDates {
    readonly from: string;
    readonly to: string;
}
export interface WardrobeWhen {
    readonly time?: WardrobeTime;
    readonly days?: readonly string[];
    readonly dates?: WardrobeDates;
}
export interface WardrobeRule {
    readonly outfit: string;
    readonly when: WardrobeWhen;
    readonly enabled?: boolean;
}
export interface Wardrobe {
    readonly outfits: readonly WardrobeOutfit[];
    readonly schedule?: readonly WardrobeRule[];
}
export interface WardrobePreferences {
    /** Fixed choice; absent = autoOutfitId behavior. `default` = base atlas. */
    readonly outfit?: string;
    /** The user's edited schedule; null/undefined = use the creator schedule. */
    readonly schedule?: readonly WardrobeRule[];
}
/**
 * Validate the `wardrobe` manifest object. Returns undefined when the wardrobe
 * is absent (or broken, which installs and lists then treat as "no wardrobe").
 */
export declare function parseWardrobe(raw: unknown): Wardrobe | undefined;
/** Evaluate one rule against a local Date; every present condition must match. */
export declare function ruleMatches(rule: WardrobeRule, date: Date): boolean;
export declare function firstMatchingRule(rules: readonly WardrobeRule[], date: Date): {
    rule: WardrobeRule;
    index: number;
} | undefined;
/**
 * Highest precedence first: fixed wardrobe choice → user schedule → creator
 * schedule → default outfit. Unknown choices/grays fall back harmlessly.
 */
export declare function resolveWardrobeOutfit(wardrobe: Wardrobe, preferences: WardrobePreferences | undefined, date: Date): string;
/** Human description of what "automatic" resolves to right now. */
export declare function describeAutomaticOutfit(wardrobe: Wardrobe, preferences: WardrobePreferences | undefined, date: Date): string;
