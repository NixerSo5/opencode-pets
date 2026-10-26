/**
 * browser-render.ts
 *
 * Pure, dependency-free CSS generation for the sprite animation — extracted
 * from OpenPets `pet-window-styles.ts` (createSpriteRule / pet-frames) with the
 * Electron parts removed so it can run in any browser.
 */
import { type SpriteStateDefinition, type UniversalSpriteState } from "./reaction-animation-mapping.js";
export interface SpriteLayout {
    readonly frameWidth: number;
    readonly frameHeight: number;
    readonly columns: number;
    readonly rows: number;
}
export declare const defaultPetLayout: SpriteLayout;
/**
 * One sprite-state rule, mirroring `createSpriteRule` from pet-window-styles.ts:
 * sets the CSS variables the shared `pet-frames` keyframes consume.
 */
export declare function createSpriteRule(selector: string, state: UniversalSpriteState, stateRows: Readonly<Record<UniversalSpriteState, SpriteStateDefinition>>, layout?: SpriteLayout): string;
/**
 * Full state-rule table for one sprite selector. A horizontally flipped pet
 * plays the mirrored directional row so the on-screen direction stays correct
 * (same rule as the original `createSpriteStateCss`).
 */
export declare function createSpriteStateCss(selector: string, stateRows: Readonly<Record<UniversalSpriteState, SpriteStateDefinition>>, layout?: SpriteLayout): string;
export interface DemoPageOptions {
    readonly scale?: number;
    readonly waitingAnimationDurationMs?: 1010 | 2200;
    readonly spritesheetUrl?: string;
}
/**
 * A complete standalone HTML page showing the pet animated with
 * reaction buttons and a speech bubble fed by the reaction message pools.
 */
export declare function createDemoPage(options?: DemoPageOptions): string;
