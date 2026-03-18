/**
 * BunMoji -- LLM-Evaluable Conditional Triggers
 *
 * Parses [type:value] condition tags for conditional sprite expressions.
 * The sidecar evaluates these against scene state during pre-gen retrieval.
 *
 * Supported condition types:
 *   emotion      -- Is this emotion present in recent messages?
 *   mood         -- Does the scene have this overall atmosphere?
 *   timeOfDay    -- Is it this time of day in the fiction?
 *   location     -- Are characters at/in this place?
 *   weather      -- Are these weather conditions present?
 *   activity     -- Are characters doing this?
 *   relationship -- Is this the dynamic between active characters?
 *   freeform     -- Custom natural-language condition evaluated by the LLM
 */

/** Valid evaluable condition types. */
export const EVALUABLE_TYPES = new Set([
    'emotion',
    'mood',
    'timeOfDay',
    'location',
    'weather',
    'activity',
    'relationship',
    'freeform',
]);

/** Human-readable descriptions for sidecar prompting. */
export const CONDITION_DESCRIPTIONS = {
    emotion: 'Is this emotion present in recent messages?',
    mood: 'Does the scene have this overall atmosphere/vibe?',
    timeOfDay: 'Is it this time of day in the fiction?',
    location: 'Are characters at or in this place?',
    weather: 'Are these weather conditions present in the scene?',
    activity: 'Are characters currently doing this?',
    relationship: 'Is this the dynamic between the active characters?',
    freeform: 'Custom natural-language condition evaluated by the LLM',
};

/** Display labels for condition type keys. */
export const CONDITION_LABELS = {
    emotion: 'Emotion',
    mood: 'Mood',
    timeOfDay: 'Time of Day',
    location: 'Location',
    weather: 'Weather',
    activity: 'Activity',
    relationship: 'Relationship',
    freeform: 'Freeform',
};

/** Regex matching [!?type:value] condition syntax (supports optional ! negation prefix). */
const CONDITION_RE = /^\[(!?\w+):(.+)\]$/;

/**
 * Check if a keyword string is an evaluable condition.
 * @param {string} keyword
 * @returns {boolean}
 */
export function isEvaluableCondition(keyword) {
    if (!keyword || typeof keyword !== 'string') return false;
    const match = keyword.trim().match(CONDITION_RE);
    if (!match) return false;
    const rawType = match[1];
    const type = rawType.startsWith('!') ? rawType.slice(1) : rawType;
    return EVALUABLE_TYPES.has(type);
}

/**
 * Parse a single [type:value] keyword into a condition object.
 * Supports optional ! negation prefix on the type (e.g. [!emotion:happy]).
 * Returns null if the keyword is not a valid condition.
 * @param {string} keyword
 * @returns {{ type: string, value: string, negated: boolean } | null}
 */
export function parseCondition(keyword) {
    if (!keyword || typeof keyword !== 'string') return null;
    const match = keyword.trim().match(CONDITION_RE);
    if (!match) return null;
    const rawType = match[1];
    const negated = rawType.startsWith('!');
    const type = negated ? rawType.slice(1) : rawType;
    if (!EVALUABLE_TYPES.has(type)) return null;
    return { type, value: match[2].trim(), negated };
}

/**
 * Format a condition object back to [type:value] string.
 * Includes ! prefix when condition.negated is true.
 * @param {{ type: string, value: string, negated?: boolean }} condition
 * @returns {string}
 */
export function formatCondition(condition) {
    return `[${condition.negated ? '!' : ''}${condition.type}:${condition.value}]`;
}

/**
 * Separate an array of keywords into regular keywords and parsed conditions.
 * @param {string[]} keys
 * @returns {{ keywords: string[], conditions: Array<{ type: string, value: string, negated: boolean }> }}
 */
export function separateConditions(keys) {
    const keywords = [];
    const conditions = [];
    if (!Array.isArray(keys)) return { keywords, conditions };

    for (const key of keys) {
        const condition = parseCondition(key);
        if (condition) {
            conditions.push(condition);
        } else {
            keywords.push(key);
        }
    }
    return { keywords, conditions };
}

// ─── BunMoji Conditional Sprite Data ─────────────────────────────

/**
 * @typedef {Object} ConditionalSprite
 * @property {string} label - The expression label (e.g. "crying_rain")
 * @property {string} spritePath - Path to sprite image (if uploaded)
 * @property {Array<Array<{type: string, value: string, negated: boolean}>>} conditionGroups - OR-joined groups of AND-joined conditions
 */

/**
 * Build the sidecar prompt section asking it to evaluate conditions
 * for a set of conditional sprites.
 * @param {ConditionalSprite[]} conditionalSprites
 * @returns {string} The prompt section describing conditions to evaluate
 */
export function buildConditionalSection(conditionalSprites) {
    if (!conditionalSprites || conditionalSprites.length === 0) return '';

    let section = 'Condition types:\n';
    for (const [type, desc] of Object.entries(CONDITION_DESCRIPTIONS)) {
        section += `- ${type}: ${desc}\n`;
    }
    section += '- Prefix ! means the condition should NOT be true (negation)\n\n';

    section += 'Conditional sprites to evaluate:\n';
    for (let i = 0; i < conditionalSprites.length; i++) {
        const cs = conditionalSprites[i];
        const groups = cs.conditionGroups || [];
        if (groups.length === 0) {
            section += `${i}: "${cs.label}" -- no conditions (always available)\n`;
        } else {
            const groupStrs = groups.map((group, gi) => {
                const conds = group.map(c => formatCondition(c)).join(' AND ');
                return `Group ${gi + 1}: ${conds}`;
            }).join(' | ');
            section += `${i}: "${cs.label}" -- ${groupStrs} (ANY group passing = activated)\n`;
        }
    }

    return section;
}

/**
 * Parse the sidecar's JSON response to determine which conditional sprites passed.
 * Expects response format: { "evaluations": [{ "index": 0, "accepted": true, "reason": "..." }, ...] }
 * @param {string} responseText - Raw response text from sidecar
 * @param {ConditionalSprite[]} conditionalSprites - The sprites that were evaluated
 * @returns {string[]} Labels of conditional sprites that passed evaluation
 */
export function parseConditionalEvaluations(responseText, conditionalSprites) {
    const passedLabels = [];
    try {
        let jsonStr = responseText.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();

        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed.evaluations)) return [];

        for (const eval_ of parsed.evaluations) {
            if (eval_ && typeof eval_.index === 'number' && eval_.accepted === true) {
                const sprite = conditionalSprites[eval_.index];
                if (sprite?.label) {
                    passedLabels.push(sprite.label);
                }
            }
        }
    } catch (e) {
        console.error('[BunMoji] Failed to parse conditional evaluation response:', e);
    }
    return passedLabels;
}
