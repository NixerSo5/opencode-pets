/**
 * browser-render.ts
 *
 * Pure, dependency-free CSS generation for the sprite animation — extracted
 * from OpenPets `pet-window-styles.ts` (createSpriteRule / pet-frames) with the
 * Electron parts removed so it can run in any browser.
 */

import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import {
  defaultPetSprite,
  mirrorDirectionalSpriteState,
  getConfiguredSpriteStates,
  type SpriteStateDefinition,
  type UniversalSpriteState,
} from "./reaction-animation-mapping.js";
import { pickReactionMessage, reactionMessagePools } from "./reaction-messages.js";
import { resolveReactionSpriteState } from "./reaction-animation-mapping.js";

export interface SpriteLayout {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly columns: number;
  readonly rows: number;
}

export const defaultPetLayout: SpriteLayout = {
  frameWidth: defaultPetSprite.frameWidth,
  frameHeight: defaultPetSprite.frameHeight,
  columns: defaultPetSprite.columns,
  rows: defaultPetSprite.rows,
};

/** Row playback geometry for one sprite state (matches the original `getCodexPetSpritePosition`: endColumn == frames so `steps(frames)` lands on whole frames). */
function spritePosition(_layout: SpriteLayout, row: SpriteStateDefinition) {
  return { startColumn: 0, endColumn: row.frames, animated: true };
}

/**
 * One sprite-state rule, mirroring `createSpriteRule` from pet-window-styles.ts:
 * sets the CSS variables the shared `pet-frames` keyframes consume.
 */
export function createSpriteRule(
  selector: string,
  state: UniversalSpriteState,
  stateRows: Readonly<Record<UniversalSpriteState, SpriteStateDefinition>>,
  layout: SpriteLayout = defaultPetLayout,
): string {
  const row = stateRows[state];
  const iterations = "iterations" in row ? row.iterations : "infinite";
  const position = spritePosition(layout, row);
  const startOffset = -(position.startColumn * layout.frameWidth);
  const endOffset = -(position.endColumn * layout.frameWidth);
  const animation = position.animated
    ? " --sprite-animation: pet-frames var(--sprite-duration) steps(var(--sprite-frames)) var(--sprite-iterations);"
    : " --sprite-animation: none;";
  return `${selector} { --sprite-row-y: -${row.row * layout.frameHeight}px; --sprite-offset-x: ${startOffset}px; --sprite-end-offset-x: ${endOffset}px; --sprite-frames: ${row.frames}; --sprite-duration: ${row.durationMs}ms; --sprite-iterations: ${iterations};${animation} }`;
}

/**
 * Full state-rule table for one sprite selector. A horizontally flipped pet
 * plays the mirrored directional row so the on-screen direction stays correct
 * (same rule as the original `createSpriteStateCss`).
 */
export function createSpriteStateCss(
  selector: string,
  stateRows: Readonly<Record<UniversalSpriteState, SpriteStateDefinition>>,
  layout: SpriteLayout = defaultPetLayout,
): string {
  const rulesFor = (attributeClause: string, state: UniversalSpriteState): string[] => {
    const mirrored = mirrorDirectionalSpriteState(state);
    if (mirrored === state) {
      return [createSpriteRule(`html${attributeClause} ${selector}`, state, stateRows, layout)];
    }
    return [
      createSpriteRule(`html:not([data-flip-x="true"])${attributeClause} ${selector}`, state, stateRows, layout),
      createSpriteRule(`html[data-flip-x="true"]${attributeClause} ${selector}`, mirrored, stateRows, layout),
    ];
  };

  return Object.keys(stateRows)
    .flatMap((state) => rulesFor(`[data-reaction-state="${state}"]`, state as UniversalSpriteState))
    .join("\n");
}

export interface DemoPageOptions {
  readonly scale?: number;
  readonly waitingAnimationDurationMs?: 1010 | 2200;
  readonly spritesheetUrl?: string;
}

/**
 * A complete standalone HTML page showing the pet animated with
 * reaction buttons and a speech bubble fed by the reaction message pools.
 */
export function createDemoPage(options: DemoPageOptions = {}): string {
  const scale = options.scale ?? 1.25;
  const waitingMs = options.waitingAnimationDurationMs ?? 1010;
  const spritesheetUrl = options.spritesheetUrl ?? "default-pet-spritesheet.webp";
  const layout = defaultPetLayout;
  const stateRows = getConfiguredSpriteStates(waitingMs);
  const reactions: readonly OpenPetsReaction[] = [
    "idle", "thinking", "working", "editing", "running", "testing",
    "waiting", "waving", "success", "error", "celebrating",
  ];

  const reactionStateRows = stateRows;
  // Bake the scale into element geometry (240×260 at 1.25) instead of
  // transforming the layer, so every background-position step stays on an
  // integer pixel and Chromium never re-rasterizes a scaled sheet.
  const scaledLayout: SpriteLayout = {
    frameWidth: layout.frameWidth * scale,
    frameHeight: layout.frameHeight * scale,
    columns: layout.columns,
    rows: layout.rows,
  };

  const spriteWidth = Math.ceil(layout.frameWidth * scale);
  const spriteHeight = Math.ceil(layout.frameHeight * scale);

  const buttons = reactions
    .map((reaction) => `<button type="button" data-reaction="${reaction}">${reaction}</button>`)
    .join("\n      ");

  return `<!doctype html>
<html lang="en" data-reaction-state="idle" data-flip-x="false">
<head>
<meta charset="utf-8" />
<title>OpenPets pet animation — standalone demo</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 18px; background: #101828; font-family: "Segoe UI", system-ui, sans-serif; color: #e2e8f0; padding-bottom: 32px; }
  h1 { font-size: 15px; font-weight: 500; color: #94a3b8; margin: 24px 0 0; }
  .bubble { position: fixed; left: 50%; transform: translateX(-50%); bottom: ${spriteHeight + 90}px; max-width: 300px; padding: 8px 14px; border-radius: 12px; background: #f8fafc; color: #172033; font-size: 14px; line-height: 1.4; opacity: 0; transition: opacity 160ms ease; box-shadow: 0 6px 20px rgba(0,0,0,0.35); text-align: center; }
  .bubble.show { opacity: 1; }
  .pet-shell { position: relative; width: ${spriteWidth}px; height: ${spriteHeight}px; }
  .sprite {
    position: absolute; left: 0; top: 0;
    width: ${scaledLayout.frameWidth}px; height: ${scaledLayout.frameHeight}px;
    background-image: url("${spritesheetUrl}");
    background-size: ${Math.ceil(layout.frameWidth * scale * layout.columns)}px ${Math.ceil(layout.frameHeight * scale * layout.rows)}px;
    background-repeat: no-repeat;
    --sprite-row-y: 0px; --sprite-offset-x: 0px; --sprite-end-offset-x: 0px;
    --sprite-frames: 6; --sprite-duration: 5500ms; --sprite-iterations: infinite;
    background-position: var(--sprite-offset-x) var(--sprite-row-y);
    animation: var(--sprite-animation, pet-frames var(--sprite-duration) steps(var(--sprite-frames)) var(--sprite-iterations));
    will-change: background-position;
  }
  .controls { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; max-width: 620px; }
  .controls button { padding: 6px 12px; border: 1px solid #334155; border-radius: 8px; background: #1e293b; color: #e2e8f0; font-size: 12px; cursor: pointer; }
  .controls button:hover { background: #334155; }
  .controls button.active { background: #2563eb; border-color: #2563eb; }
  @keyframes pet-frames {
    from { background-position: var(--sprite-offset-x) var(--sprite-row-y); }
    to { background-position: var(--sprite-end-offset-x) var(--sprite-row-y); }
  }
  ${createSpriteStateCss(".sprite", reactionStateRows, scaledLayout)}
</style>
</head>
<body>
  <h1>OpenPets sprite animation — click a reaction to switch animation + bubble</h1>
  <div class="bubble" id="bubble"></div>
  <div class="pet-shell"><div class="sprite" role="img" aria-label="animated pet"></div></div>
  <div class="controls" id="controls">
    ${buttons}
  </div>
<script>
  const reactions = ${JSON.stringify(reactions)};
  const reactionToSpriteState = ${JSON.stringify(Object.fromEntries(reactions.map((reaction) => [reaction, resolveSpriteState(reaction)])))};
  const messages = ${JSON.stringify(Object.fromEntries(reactions.map((reaction) => [reaction, ...pickAllMessages(reaction)])))};
  const root = document.documentElement;
  const bubble = document.getElementById("bubble");
  let hideTimer;
  document.getElementById("controls").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-reaction]");
    if (!button) return;
    const reaction = button.getAttribute("data-reaction");
    // The host maps reaction -> sprite state before applying it; the CSS rules
    // key on the sprite state (review/running/...), not the raw reaction.
    root.setAttribute("data-reaction-state", reactionToSpriteState[reaction] ?? "idle");
    document.querySelectorAll(".controls button").forEach((b) => b.classList.toggle("active", b === button));
    const pool = messages[reaction];
    const text = pool[Math.floor(Math.random() * pool.length)];
    bubble.textContent = text;
    bubble.classList.add("show");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bubble.classList.remove("show"), 3000);
  });
  document.querySelector('button[data-reaction="idle"]').classList.add("active");
</script>
</body>
</html>`;
}

/** All messages of a pool, so demo bubbles pick randomly like the host does. */
function pickAllMessages(reaction: OpenPetsReaction): readonly string[] {
  const pool = reactionMessagePools[reaction] as readonly string[];
  return pool;
}

/** Reaction -> sprite state, the same mapping the host applies before rendering. */
function resolveSpriteState(reaction: OpenPetsReaction): string {
  return resolveReactionSpriteState(reaction);
}
