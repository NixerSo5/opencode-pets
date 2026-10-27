/**
 * desktop-render.ts
 *
 * Pet-only transparent page for the Electron desktop pet window — mirrors the
 * original pet HTML document structure (sprite CSS + state rules), without any
 * web-demo chrome.
 */
import { type UniversalSpriteState } from "./reaction-animation-mapping.js";
/**
 * Escapes HTML-significant characters. Defined at module scope (not inside the
 * page template) so `renderMarkdownText` can be injected with toString().
 */
export declare function escapeHtmlText(value: string): string;
/**
 * Lightweight, language-agnostic syntax highlighting for fenced code blocks.
 * `escaped` must already be HTML-escaped: this only inserts <span> tags around
 * tokens, never raw text. Kept at module scope because the regex literals below
 * contain backslashes that the page template string would eat.
 *
 * Strategy: string and comment spans are stashed behind placeholders before the
 * keyword/number passes run, so a keyword inside a string is not recoloured.
 */
export declare function highlightCodeText(escaped: string): string;
/**
 * Minimal Markdown renderer for assistant replies. Lives outside the page
 * template on purpose: its regex literals contain backslashes and backticks
 * that a template string would mangle. Injected with toString().
 */
export declare function renderMarkdownText(source: string): string;
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
