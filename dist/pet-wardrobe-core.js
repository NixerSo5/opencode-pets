/**
 * pet-wardrobe-core.ts
 *
 * Pure wardrobe (outfit) contract for the standalone pet, mirroring the
 * original `pet-wardrobe-core.ts` semantics: outfit validation rules, schedule
 * rule parsing, and the preference-ordered outfit resolution
 * (always-wear > user schedule > creator schedule > default).
 *
 * No Electron / filesystem / pet-store imports: this must stay testable and
 * deterministic down to the `date` passed by the caller.
 */
export const wardrobeDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const defaultOutfitId = "default";
/** Preference value meaning "ignore any fixed choice, follow the schedule". */
export const autoOutfitId = "auto";
const outfitIdPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const hhmmPattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const mmddPattern = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : undefined;
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
/** How many outfits a pet may declare. */
const maxOutfits = 16;
/** How many schedule rules any one schedule may carry. */
const maxRules = 32;
function momentMinutes(hhmm) {
    const [h, m] = hhmm.split(":").map((part) => Number.parseInt(part, 10));
    return h * 60 + m;
}
function timeValid(time) {
    const record = asRecord(time);
    if (record === undefined)
        return false;
    const from = asString(record.from);
    const to = asString(record.to);
    return from !== undefined && to !== undefined && hhmmPattern.test(from) && hhmmPattern.test(to) && from !== to;
}
function daysValid(days) {
    return Array.isArray(days) && days.length > 0 && days.every((day) => wardrobeDays.includes(day));
}
function datesValid(dates) {
    const record = asRecord(dates);
    if (record === undefined)
        return false;
    const from = asString(record.from);
    const to = asString(record.to);
    return from !== undefined && to !== undefined && mmddPattern.test(from) && mmddPattern.test(to) && from !== to;
}
function whenValid(when) {
    const record = asRecord(when);
    if (record === undefined)
        return false;
    const time = record.time;
    const days = record.days;
    const dates = record.dates;
    const present = (time !== undefined ? 1 : 0) + (days !== undefined ? 1 : 0) + (dates !== undefined ? 1 : 0);
    if (present === 0)
        return false;
    if (time !== undefined && !timeValid(time))
        return false;
    if (days !== undefined && !daysValid(days))
        return false;
    if (dates !== undefined && !datesValid(dates))
        return false;
    return true;
}
/**
 * Validate rule objects for a schedule whose outfits have already been
 * filtered. Malformed rules are dropped silently; valid ones are kept (this
 * matches the host's normalizeState, which never validates failures loudly).
 */
function parseRules(raw, outfitIds) {
    if (!Array.isArray(raw))
        return [];
    const rules = [];
    for (const candidate of raw) {
        const record = asRecord(candidate);
        if (record === undefined)
            continue;
        const outfit = asString(record.outfit);
        if (outfit === undefined || !outfitIds.has(outfit))
            continue;
        const when = record.when;
        if (!whenValid(when))
            continue;
        const enabled = record.enabled;
        if (enabled !== undefined && typeof enabled !== "boolean")
            continue;
        rules.push({ outfit, when: when, ...(enabled === undefined ? {} : { enabled }) });
        if (rules.length >= maxRules)
            break;
    }
    return rules;
}
/**
 * Validate the `wardrobe` manifest object. Returns undefined when the wardrobe
 * is absent (or broken, which installs and lists then treat as "no wardrobe").
 */
export function parseWardrobe(raw) {
    const record = asRecord(raw);
    if (record === undefined)
        return undefined;
    const parsedOutfits = [];
    for (const candidate of Array.isArray(record.outfits) ? record.outfits : []) {
        const outfit = asRecord(candidate);
        if (outfit === undefined)
            continue;
        const id = asString(outfit.id);
        const displayName = asString(outfit.displayName)?.trim();
        const spritesheetPath = asString(outfit.spritesheetPath);
        if (id === undefined || !outfitIdPattern.test(id) || id === defaultOutfitId || id === autoOutfitId)
            continue;
        if (displayName === undefined || displayName.length === 0 || displayName.length > 40)
            continue;
        if (spritesheetPath !== `outfits/${id}.webp` && spritesheetPath !== `outfits/${id}.svg`)
            continue;
        parsedOutfits.push({ id, displayName, spritesheetPath });
        if (parsedOutfits.length >= maxOutfits)
            break;
    }
    if (parsedOutfits.length === 0)
        return undefined;
    const outfitIds = new Set(parsedOutfits.map((outfit) => outfit.id));
    outfitIds.add(defaultOutfitId);
    const schedule = parseRules(record.schedule, outfitIds);
    return { outfits: parsedOutfits, ...(schedule.length > 0 ? { schedule } : {}) };
}
// ---------------------------------------------------------------------------
// Schedule evaluation
// ---------------------------------------------------------------------------
function timeMatches(time, minutesOfDay) {
    const from = momentMinutes(time.from);
    const to = momentMinutes(time.to);
    return from < to ? minutesOfDay >= from && minutesOfDay < to : minutesOfDay >= from || minutesOfDay < to;
}
function datesMatches(dates, monthDay) {
    const from = dates.from;
    const to = dates.to;
    // Yearly, inclusive at both ends, wraps the new year when to < from.
    return from < to ? monthDay >= from && monthDay <= to : monthDay >= from || monthDay <= to;
}
/** Evaluate one rule against a local Date; every present condition must match. */
export function ruleMatches(rule, date) {
    if (rule.enabled === false)
        return false;
    if (rule.when.time !== undefined && !timeMatches(rule.when.time, date.getHours() * 60 + date.getMinutes()))
        return false;
    if (rule.when.days !== undefined && !rule.when.days.includes(wardrobeDays[date.getDay()]))
        return false;
    if (rule.when.dates !== undefined) {
        const month = `${date.getMonth() + 1}`.padStart(2, "0");
        const day = `${date.getDate()}`.padStart(2, "0");
        if (!datesMatches(rule.when.dates, `${month}-${day}`))
            return false;
    }
    return true;
}
export function firstMatchingRule(rules, date) {
    for (let index = 0; index < rules.length; index += 1) {
        if (ruleMatches(rules[index], date))
            return { rule: rules[index], index };
    }
    return undefined;
}
/**
 * Highest precedence first: fixed wardrobe choice → user schedule → creator
 * schedule → default outfit. Unknown choices/grays fall back harmlessly.
 */
export function resolveWardrobeOutfit(wardrobe, preferences, date) {
    const outfitIds = new Set(wardrobe.outfits.map((outfit) => outfit.id));
    const fixed = preferences?.outfit;
    if (fixed !== undefined && fixed !== autoOutfitId) {
        if (fixed === defaultOutfitId || outfitIds.has(fixed))
            return fixed;
    }
    const schedule = preferences?.schedule ?? wardrobe.schedule;
    if (Array.isArray(schedule)) {
        const matching = firstMatchingRule(schedule, date);
        if (matching !== undefined && outfitIds.has(matching.rule.outfit))
            return matching.rule.outfit;
        if (matching !== undefined && matching.rule.outfit === defaultOutfitId)
            return defaultOutfitId;
    }
    return defaultOutfitId;
}
/** Human description of what "automatic" resolves to right now. */
export function describeAutomaticOutfit(wardrobe, preferences, date) {
    const name = (outfitId) => wardrobe.outfits.find((outfit) => outfit.id === outfitId)?.displayName ?? outfitId;
    if (preferences?.schedule !== undefined) {
        const matching = firstMatchingRule(preferences.schedule, date);
        if (matching?.rule.outfit === defaultOutfitId)
            return name(defaultOutfitId);
        if (matching !== undefined)
            return name(matching.rule.outfit);
    }
    if (wardrobe.schedule !== undefined) {
        const matching = firstMatchingRule(wardrobe.schedule, date);
        if (matching?.rule.outfit === defaultOutfitId)
            return name(defaultOutfitId);
        if (matching !== undefined)
            return name(matching.rule.outfit);
    }
    return name(defaultOutfitId);
}
