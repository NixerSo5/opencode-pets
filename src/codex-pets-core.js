import sharp from "sharp";
import { getPetSpritesheetSpec, validateSvgSpritesheet } from "install-pet/spritesheet";
import { validatePetWardrobe } from "./pet-wardrobe-core.js";
export const maxCodexPetJsonBytes = 128 * 1024;
export const maxCodexSpritesheetBytes = 100 * 1024 * 1024;
export const maxCodexThumbnailSourceBytes = 24 * 1024 * 1024;
export const maxCodexPets = 100;
export const codexV1SpriteLayout = {
    version: 1,
    frameWidth: 192,
    frameHeight: 208,
    columns: 8,
    rows: 9,
};
export const codexV2SpriteLayout = {
    version: 2,
    frameWidth: 192,
    frameHeight: 208,
    columns: 8,
    rows: 11,
    neutralPose: { row: 0, column: 6 },
};
export const codexV2GazeSectorCount = 16;
export const codexV2GazeSectorAngle = (Math.PI * 2) / codexV2GazeSectorCount;
export const codexV2GazeDeadZonePx = 24;
export const codexV2GazeIdleResetMs = 1_200;
/**
 * Resolve a normalized frame anchor against the base-scale card origin and the
 * sprite's effective transform scale. Omission preserves the legacy carrier
 * bottom-center anchor.
 */
export function getCodexV2GazeAnchorPoint(bounds, frame, layoutScale, spriteScaleOverride, gazeAnchor, flipped, spriteBottomInset) {
    if (!gazeAnchor)
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
    const layoutFrameWidth = Math.ceil(frame.width * layoutScale);
    const layoutFrameHeight = Math.ceil(frame.height * layoutScale);
    const spriteLeft = bounds.x + (bounds.width - layoutFrameWidth) / 2;
    const spriteTop = bounds.y + bounds.height - spriteBottomInset - layoutFrameHeight;
    const spriteScale = spriteScaleOverride ?? layoutScale;
    const frameAnchorX = gazeAnchor.x * frame.width * spriteScale;
    return {
        x: spriteLeft + (flipped ? layoutFrameWidth - frameAnchorX : frameAnchorX),
        y: spriteTop + gazeAnchor.y * frame.height * spriteScale,
    };
}
export function isCodexV2GazeActive(lastCursorMovedAt, now, idleResetMs = codexV2GazeIdleResetMs) {
    return lastCursorMovedAt !== null
        && Number.isFinite(lastCursorMovedAt)
        && Number.isFinite(now)
        && Number.isFinite(idleResetMs)
        && idleResetMs > 0
        && now - lastCursorMovedAt < idleResetMs;
}
export function shouldTrackCodexV2Gaze(state) {
    return state.spriteVersion === 2
        && state.idleCursorGazeEnabled
        && !state.paused
        && state.reactionState === "idle"
        && state.motionState === "idle"
        && !state.pluginSpriteOverride;
}
/**
 * Quantize a cursor point around the pet carrier's bottom-center anchor.
 * Index zero points up and indices increase clockwise in 22.5 degree steps.
 */
export function quantizeCodexV2GazeDirection(cursor, anchor, deadZonePx = codexV2GazeDeadZonePx) {
    if (!isFinitePoint(cursor) || !isFinitePoint(anchor) || !Number.isFinite(deadZonePx) || deadZonePx < 0)
        return null;
    const dx = cursor.x - anchor.x;
    const dy = cursor.y - anchor.y;
    if (Math.hypot(dx, dy) <= deadZonePx)
        return null;
    const angle = Math.atan2(dx, -dy);
    const sector = Math.floor((angle + codexV2GazeSectorAngle / 2) / codexV2GazeSectorAngle);
    return (sector + codexV2GazeSectorCount) % codexV2GazeSectorCount;
}
/** Mirror a gaze index before the renderer applies its horizontal CSS flip. */
export function mirrorCodexV2GazeIndex(index) {
    if (!isCodexV2GazeIndex(index))
        return null;
    return (codexV2GazeSectorCount - index) % codexV2GazeSectorCount;
}
/** Return the static V2 atlas cell for a gaze index, optionally flip-compensated. */
export function getCodexV2GazeSpritePosition(index, flipped = false) {
    if (!isCodexV2GazeIndex(index))
        return null;
    const selectedIndex = flipped ? mirrorCodexV2GazeIndex(index) : index;
    if (selectedIndex === null)
        return null;
    return selectedIndex < 8
        ? { row: 9, column: selectedIndex }
        : { row: 10, column: selectedIndex - 8 };
}
function isCodexV2GazeIndex(value) {
    return Number.isInteger(value) && value >= 0 && value < codexV2GazeSectorCount;
}
function isFinitePoint(value) {
    return typeof value === "object"
        && value !== null
        && Number.isFinite(value.x)
        && Number.isFinite(value.y);
}
export function validateCodexPetMetadata(value, folderName) {
    if (!isSafeCodexPetId(folderName))
        throw new Error("Codex pet folder name is invalid.");
    if (!isRecord(value))
        throw new Error("pet.json must be an object.");
    const spritesheet = getPetSpritesheetSpec(value);
    if (value.id !== folderName || typeof value.id !== "string")
        throw new Error("Codex pet id must match its folder name.");
    if (!isSafeCodexPetId(value.id))
        throw new Error("Codex pet id is invalid.");
    if (typeof value.displayName !== "string" || value.displayName.trim().length === 0 || value.displayName.length > 80)
        throw new Error("Codex pet displayName is invalid.");
    if (typeof value.description !== "string" || value.description.trim().length === 0 || value.description.length > 500)
        throw new Error("Codex pet description is invalid.");
    const gazeAnchor = value.gazeAnchor === undefined ? undefined : validateCodexPetGazeAnchor(value.gazeAnchor);
    const wardrobe = value.wardrobe === undefined ? undefined : validatePetWardrobe(value.wardrobe);
    return {
        id: value.id,
        displayName: value.displayName.trim(),
        description: value.description.trim(),
        spritesheetPath: spritesheet.spritesheetPath,
        ...(spritesheet.version === 2 ? { spriteVersionNumber: 2 } : {}),
        ...(gazeAnchor ? { gazeAnchor } : {}),
        ...(wardrobe ? { wardrobe } : {}),
    };
}
function validateCodexPetGazeAnchor(value) {
    if (!isRecord(value)
        || typeof value.x !== "number"
        || !Number.isFinite(value.x)
        || value.x < 0
        || value.x > 1
        || typeof value.y !== "number"
        || !Number.isFinite(value.y)
        || value.y < 0
        || value.y > 1) {
        throw new Error("Codex pet gazeAnchor must contain normalized finite x and y coordinates.");
    }
    return { x: value.x, y: value.y };
}
export function getCodexPetSpriteLayout(value) {
    if (!isRecord(value) || !Object.hasOwn(value, "spriteVersionNumber"))
        return codexV1SpriteLayout;
    if (value.spriteVersionNumber === 2)
        return codexV2SpriteLayout;
    throw new Error("Codex pet spriteVersionNumber must be 2 when provided.");
}
export function getCodexPetSpritePosition(layout, state, useNeutralPose = false) {
    const neutralPose = useNeutralPose ? layout.neutralPose : undefined;
    if (neutralPose && state.row === neutralPose.row) {
        return { row: neutralPose.row, startColumn: neutralPose.column, endColumn: neutralPose.column, animated: false };
    }
    return { row: state.row, startColumn: 0, endColumn: state.frames, animated: true };
}
export async function validateCodexPetSpritesheet(spritesheet, metadata) {
    const spec = getPetSpritesheetSpec(metadata);
    if (metadata.spritesheetPath === "spritesheet.svg") {
        validateSvgSpritesheet(spritesheet, spec.width, spec.height);
        return;
    }
    if (spec.version === 1)
        return;
    await assertDecodableWebpAtlas(spritesheet, spec, "Codex V2 spritesheet", true);
}
/**
 * Validate one wardrobe outfit atlas against its pet's layout. Unlike legacy V1
 * base atlases, outfits are new content, so V1 WebP outfits must also decode at
 * the exact size: a broken outfit would otherwise render a blank pet.
 */
export async function validateCodexPetOutfitSpritesheet(spritesheet, metadata, format) {
    const formatMetadata = withAtlasFormat(metadata, format);
    await validateCodexPetSpritesheet(spritesheet, formatMetadata);
    const spec = getPetSpritesheetSpec(formatMetadata);
    if (format === "spritesheet.webp" && spec.version === 1) {
        await assertDecodableWebpAtlas(spritesheet, spec, "Outfit spritesheet", false);
    }
}
/**
 * The pet's layout with another atlas format, for validating an outfit atlas.
 * V1 must omit `spriteVersionNumber` entirely: a present key means V2.
 */
export function withAtlasFormat(metadata, format) {
    return { ...(metadata.spriteVersionNumber === 2 ? { spriteVersionNumber: 2 } : {}), spritesheetPath: format };
}
async function assertDecodableWebpAtlas(spritesheet, spec, label, requireAlpha) {
    let imageMetadata;
    const image = sharp(spritesheet, { animated: true, failOn: "error", limitInputPixels: 50_000_000 });
    try {
        imageMetadata = await image.metadata();
    }
    catch {
        throw new Error(`${label} metadata is invalid.`);
    }
    if (imageMetadata.format !== "webp")
        throw new Error(`${label} must be WebP.`);
    if (requireAlpha && !imageMetadata.hasAlpha)
        throw new Error(`${label} must include transparency.`);
    if ((imageMetadata.pages ?? 1) !== 1)
        throw new Error(`${label} must contain exactly one image.`);
    if (imageMetadata.width !== spec.width || imageMetadata.height !== spec.height) {
        throw new Error(`${label} must be exactly ${spec.width}x${spec.height}.`);
    }
    try {
        await image.raw().toBuffer();
    }
    catch {
        throw new Error(`${label} must be fully decodable.`);
    }
}
function isSafeCodexPetId(value) {
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && value !== "builtin";
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
