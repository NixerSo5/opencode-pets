import { type OpenPetsReaction } from "./local-ipc-protocol.js";
export declare const reactionMessagePools: {
    readonly idle: readonly ["Ready", "Standing by", "Available", "On standby", "Ready when needed", "Keeping watch", "All quiet", "At rest", "Calm and ready", "Here if needed", "Quiet mode", "Watching the queue"];
    readonly thinking: readonly ["Reviewing", "Checking context", "Planning", "Considering options", "Looking closer", "Tracing this", "Sorting it out", "Reading context", "Weighing paths", "Scanning details", "Building a plan", "Following clues"];
    readonly working: readonly ["In progress", "Handling task", "Making progress", "Processing", "Working through it", "Continuing work", "On the task", "Moving along", "Making headway", "Steady progress", "Task in hand", "Keeping momentum"];
    readonly editing: readonly ["Updating files", "Applying changes", "Adjusting code", "Refining changes", "Cleaning up", "Changing files", "Updating the diff", "Polishing changes", "Tweaking details", "Shaping the patch", "Reworking code", "Tidying files"];
    readonly running: readonly ["Starting task", "Process started", "Task underway", "In motion", "Command underway", "Shell is busy", "Process active", "Awaiting output", "Job in progress", "Tool is active", "Command launched", "Watching results"];
    readonly testing: readonly ["Running checks", "Verifying", "Checking results", "Looking for failures", "Confirming behavior", "Checking regressions", "Validating fix", "Checking output", "Reviewing output", "Scanning failures", "Confirming checks", "Probing behavior"];
    readonly waiting: readonly ["Approval needed", "Paused for review", "Need a decision", "Ready for approval", "Paused", "Your call", "Input needed", "Decision point", "Review requested", "Holding here", "Need direction", "Standing aside"];
    readonly waving: readonly ["Hello", "Checking in", "Attention needed", "Quick update", "Notice", "Over here", "Ping", "Heads up", "Small nudge", "Status note", "New signal", "Just a ping"];
    readonly success: readonly ["Done", "All set", "Finished", "Complete", "Checks passed", "Ready", "Good to go", "Wrapped up", "Checks are clean", "Task complete", "Green light", "Result landed"];
    readonly error: readonly ["Failed", "Needs attention", "Issue found", "Check failed", "Problem detected", "Not complete", "Review needed", "Something broke", "Needs a look", "Blocked by issue", "Red flag raised", "Retry needed"];
    readonly celebrating: readonly ["Nice work", "Win confirmed", "Great result", "Success moment", "That worked", "Finished well", "Victory", "Happy dance", "Big finish", "Win landed", "Result shines", "Moment earned"];
};
export declare function pickReactionMessage(reaction: OpenPetsReaction, random?: () => number): string;
