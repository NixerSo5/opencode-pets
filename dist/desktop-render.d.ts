/**
 * desktop-render.ts
 *
 * Pet-only transparent page for the Electron desktop pet window — mirrors the
 * original pet HTML document structure (sprite CSS + state rules), without any
 * web-demo chrome.
 */
import { type UniversalSpriteState } from "./reaction-animation-mapping.js";
export interface PetPageOptions {
    readonly scale?: number;
    readonly waitingAnimationDurationMs?: 1010 | 2200;
    readonly spritesheetUrl?: string;
    /** 11 rows = V2 8×11 atlas (built-in Hoodie Cat); 9 rows = V1 8×9 atlas. Rows 0-8 carry the reaction states in both. */
    readonly atlasRows?: number;
    /** Display name shown in the chat panel header. */
    readonly petName?: string;
}
/** Full HTML document for the transparent pet window. */
export declare function createPetPageHtml(options?: PetPageOptions): string;
/** Types over the states the desktop pet cycles through. */
export type PetDemoState = UniversalSpriteState;
