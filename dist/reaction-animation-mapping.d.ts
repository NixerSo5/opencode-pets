import { type OpenPetsReaction } from "./local-ipc-protocol.js";
import { type WaitingAnimationDurationMs } from "./app-state-core.js";
export type PetMotionState = "idle" | "run-left" | "run-right";
export type UniversalSpriteState = "idle" | "running-right" | "running-left" | "waving" | "jumping" | "failed" | "waiting" | "running" | "review";
export type UserSelectableAnimationState = Exclude<UniversalSpriteState, "running-left" | "running-right">;
export type ReactionAnimationOverrides = Partial<Record<OpenPetsReaction, UserSelectableAnimationState>>;
export { defaultWaitingAnimationDurationMs, normalizeWaitingAnimationDurationMs, waitingAnimationDurationOptions, type WaitingAnimationDurationMs } from "./app-state-core.js";
export interface SpriteStateDefinition {
    readonly row: number;
    readonly frames: number;
    readonly durationMs: number;
    readonly iterations?: number | "infinite";
}
export declare const motionToSpriteState: {
    readonly idle: "idle";
    readonly "run-right": "running-right";
    readonly "run-left": "running-left";
};
export declare function mirrorDirectionalSpriteState(state: UniversalSpriteState): UniversalSpriteState;
export declare const defaultReactionToSpriteState: {
    readonly idle: "idle";
    readonly thinking: "review";
    readonly working: "running";
    readonly editing: "running";
    readonly running: "running";
    readonly testing: "waiting";
    readonly waiting: "waiting";
    readonly waving: "waving";
    readonly success: "jumping";
    readonly error: "failed";
    readonly celebrating: "jumping";
};
export declare const defaultPetSprite: {
    readonly fileName: "default-pet-spritesheet.webp";
    readonly frameWidth: 192;
    readonly frameHeight: 208;
    readonly columns: 8;
    readonly rows: 11;
    readonly version: 2;
    readonly states: {
        idle: {
            row: number;
            frames: number;
            durationMs: number;
            iterations: "infinite";
        };
        "running-right": {
            row: number;
            frames: number;
            durationMs: number;
        };
        "running-left": {
            row: number;
            frames: number;
            durationMs: number;
        };
        waving: {
            row: number;
            frames: number;
            durationMs: number;
            iterations: number;
        };
        jumping: {
            row: number;
            frames: number;
            durationMs: number;
            iterations: number;
        };
        failed: {
            row: number;
            frames: number;
            durationMs: number;
            iterations: number;
        };
        waiting: {
            row: number;
            frames: number;
            durationMs: number;
        };
        running: {
            row: number;
            frames: number;
            durationMs: number;
        };
        review: {
            row: number;
            frames: number;
            durationMs: number;
        };
    };
};
export declare const selectableAnimationMetadata: readonly [{
    readonly id: "idle";
    readonly label: "Idle";
    readonly description: "Neutral/no special movement.";
}, {
    readonly id: "review";
    readonly label: "Review";
    readonly description: "Thinking, reading, reviewing.";
}, {
    readonly id: "running";
    readonly label: "Running";
    readonly description: "Active work, editing, executing.";
}, {
    readonly id: "waiting";
    readonly label: "Waiting";
    readonly description: "Waiting, blocked, testing, permission pending.";
}, {
    readonly id: "waving";
    readonly label: "Waving";
    readonly description: "Attention, greeting, notification.";
}, {
    readonly id: "jumping";
    readonly label: "Jumping";
    readonly description: "Success, celebration.";
}, {
    readonly id: "failed";
    readonly label: "Failed";
    readonly description: "Error or failure.";
}];
export declare const reactionAnimationMetadata: readonly [{
    readonly id: "idle";
    readonly label: "Idle";
    readonly description: "Explicit neutral reaction.";
    readonly defaultAnimation: "idle";
}, {
    readonly id: "thinking";
    readonly label: "Thinking";
    readonly description: "Agent is reasoning or reviewing.";
    readonly defaultAnimation: "review";
}, {
    readonly id: "working";
    readonly label: "Working";
    readonly description: "Agent is doing general tool work.";
    readonly defaultAnimation: "running";
}, {
    readonly id: "editing";
    readonly label: "Editing";
    readonly description: "Agent is changing files.";
    readonly defaultAnimation: "running";
}, {
    readonly id: "running";
    readonly label: "Running";
    readonly description: "Agent is running a command.";
    readonly defaultAnimation: "running";
}, {
    readonly id: "testing";
    readonly label: "Testing";
    readonly description: "Agent is running checks.";
    readonly defaultAnimation: "waiting";
}, {
    readonly id: "waiting";
    readonly label: "Waiting";
    readonly description: "Agent is blocked or waiting for permission.";
    readonly defaultAnimation: "waiting";
}, {
    readonly id: "waving";
    readonly label: "Waving";
    readonly description: "Pet is greeting or getting attention.";
    readonly defaultAnimation: "waving";
}, {
    readonly id: "success";
    readonly label: "Success";
    readonly description: "Task completed successfully.";
    readonly defaultAnimation: "jumping";
}, {
    readonly id: "error";
    readonly label: "Error";
    readonly description: "Something failed.";
    readonly defaultAnimation: "failed";
}, {
    readonly id: "celebrating";
    readonly label: "Celebrating";
    readonly description: "Positive manual reaction.";
    readonly defaultAnimation: "jumping";
}];
export declare function getConfiguredSpriteStates(waitingAnimationDurationMs?: WaitingAnimationDurationMs): Record<UniversalSpriteState, SpriteStateDefinition>;
export declare function getConfiguredSpriteCacheKey(waitingAnimationDurationMs: WaitingAnimationDurationMs): string;
export declare function isUserSelectableAnimationState(value: unknown): value is UserSelectableAnimationState;
export declare function normalizeReactionAnimationOverrides(value: unknown): ReactionAnimationOverrides | undefined;
export declare function validateReactionAnimationOverrides(value: unknown): ReactionAnimationOverrides | undefined;
export declare function resolveReactionSpriteState(reaction: OpenPetsReaction | undefined, overrides?: ReactionAnimationOverrides | undefined): UserSelectableAnimationState;
export declare function isLoopingSpriteState(state: UniversalSpriteState, states?: Record<UniversalSpriteState, SpriteStateDefinition>): boolean;
export declare function resolveEffectiveSpriteState(displayReaction: OpenPetsReaction | undefined, badgeReaction: OpenPetsReaction | undefined, overrides?: ReactionAnimationOverrides, states?: Record<UniversalSpriteState, SpriteStateDefinition>): UserSelectableAnimationState;
