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
/**
 * Extract the `--dir` value from argv.
 *
 * Two argv shapes reach us:
 *
 * 1. First launch — Explorer's script passes `--dir <path>` normally.
 * 2. `second-instance` — Electron re-orders argv before delivering it: every
 *    `--switch` moves to the front, then bare arguments follow. The click path
 *    ends up as a bare argument near the end (next to the app directory and
 *    the `0 0` coordinates), and `--dir` is followed by another switch. A
 *    position-based read therefore always loses the path.
 *
 * For case 2, pick the last bare argument that resolves to an existing
 * directory. The app path also resolves, but the clicked folder comes after
 * it, so `last` is the correct one.
 */
function findDirectoryArg(argv) {
    const PREFIX = "--dir=";
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === "--dir") {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--"))
                return next;
            continue;
        }
        if (token.startsWith(PREFIX)) {
            const value = token.slice(PREFIX.length);
            if (value.length > 0)
                return value;
        }
    }
    // Fallback for the re-ordered `second-instance` shape.
    for (let i = argv.length - 1; i >= 0; i -= 1) {
        const token = argv[i];
        if (token.startsWith("--") || token.length === 0)
            continue;
        // Skip pure numbers (the `0 0` coordinates).
        if (/^-?\d+$/.test(token))
            continue;
        const absolute = resolve(token);
        if (existsSync(absolute) && statSync(absolute).isDirectory())
            return absolute;
    }
    return undefined;
}
/** Parse argv (without the electron/exe prefix). Returns undefined when not a summon. */
export function parseSummonRequest(argv) {
    if (!argv.includes(SUMMON_FLAG))
        return undefined;
    return {
        directory: resolveDirectory(findDirectoryArg(argv)),
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
