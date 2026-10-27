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
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
const SUMMON_FLAG = "--summon";
export function desktopDirectory() {
    return resolve(homedir(), "Desktop");
}
/**
 * Turn a raw path argument into a directory: folders stay, files resolve to
 * their parent, and anything missing falls back to the desktop.
 */
function resolveDirectory(raw) {
    const value = raw?.trim().replace(/^"(.*)"$/, "$1");
    if (value === undefined || value.length === 0 || value === "%V" || value === "%1")
        return desktopDirectory();
    const absolute = resolve(value);
    if (!existsSync(absolute))
        return desktopDirectory();
    return statSync(absolute).isDirectory() ? absolute : dirname(absolute);
}
function readNumber(args, flag) {
    const index = args.indexOf(flag);
    const raw = index === -1 ? undefined : args[index + 1];
    if (raw === undefined)
        return undefined;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : undefined;
}
/**
 * A static Explorer verb cannot read the click position, so pet-launch.cmd
 * always passes `0 0`. Treat the origin as "no position given" and let the
 * caller fall back to the real cursor location.
 */
function readCursorCoord(args, flag) {
    const value = readNumber(args, flag);
    return value === 0 ? undefined : value;
}
/** Parse argv (without the electron/exe prefix). Returns undefined when not a summon. */
export function parseSummonRequest(argv) {
    if (!argv.includes(SUMMON_FLAG))
        return undefined;
    const dirIndex = argv.indexOf("--dir");
    return {
        directory: resolveDirectory(dirIndex === -1 ? undefined : argv[dirIndex + 1]),
        x: readCursorCoord(argv, "--x"),
        y: readCursorCoord(argv, "--y"),
    };
}
/** Clamp a cursor point so the pet window stays fully on the target work area. */
export function placeAtCursor(request, workArea, windowSize) {
    const anchorX = request.x ?? workArea.x + workArea.width - windowSize.width - 24;
    const anchorY = request.y ?? workArea.y + workArea.height - windowSize.height - 8;
    return {
        x: Math.min(Math.max(anchorX, workArea.x + 2), workArea.x + workArea.width - windowSize.width - 2),
        y: Math.min(Math.max(anchorY, workArea.y + 2), workArea.y + workArea.height - windowSize.height - 2),
    };
}
