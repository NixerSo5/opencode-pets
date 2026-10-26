/**
 * summon.ts
 *
 * Parses the "summon pet here" invocation produced by the Windows Explorer
 * context menu, and normalises the folder / cursor position it carries.
 *
 * Explorer passes `%V` (target path) plus explicit x/y args, because a plain
 * static shell verb cannot read the click position itself. Every field is
 * therefore best-effort: a missing path falls back to the desktop, and a
 * missing cursor position lets the caller pick a default spot.
 */
export interface SummonRequest {
    readonly directory: string;
    readonly x?: number;
    readonly y?: number;
}
export declare function desktopDirectory(): string;
/** Parse argv (without the electron/exe prefix). Returns undefined when not a summon. */
export declare function parseSummonRequest(argv: readonly string[]): SummonRequest | undefined;
/** Clamp a cursor point so the pet window stays fully on the target work area. */
export declare function placeAtCursor(request: SummonRequest, workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
}, windowSize: {
    width: number;
    height: number;
}): {
    x: number;
    y: number;
};
