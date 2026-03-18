/**
 * BunMoji Sidecar Evaluation
 * Single sidecar call that evaluates conditionals + picks expression/background.
 * Conditionals override labels: if any pass, the model picks ONLY from those.
 */

import { getContext } from '../../../st-context.js';
import { getSettings } from './index.js';
import { sidecarGenerateWithTools, sidecarGenerate, isSidecarConfigured } from './llm-sidecar.js';
import { CONDITION_DESCRIPTIONS, formatCondition } from './conditions.js';
import { getAvailableLabels, fetchBackgroundsList, restoreExpression, applyBackground, getDisplayLabel, saveToMetadata, resolveFileLabel } from './tool.js';
import { extension_settings } from '../../../extensions.js';
import { setSidecarActive, addFeedItem } from './activity-feed.js';

/**
 * @typedef {Object} SidecarResult
 * @property {string|null} expression
 * @property {string|null} background
 */

/**
 * Run the sidecar — single call handles conditionals + selection.
 * @returns {Promise<SidecarResult>}
 */
export async function runSidecar() {
    const settings = getSettings();

    if (!isSidecarConfigured()) {
        console.warn('[BunMoji] Sidecar not configured.');
        return { expression: null, background: null };
    }

    const context = getContext();
    const msgCount = settings.contextMessages || 10;
    const recentMessages = (context.chat || [])
        .filter(m => m.mes && !m.is_system)
        .slice(-msgCount)
        .map(m => `${m.is_user ? 'User' : m.name}: ${m.mes}`)
        .join('\n');

    if (!recentMessages) return { expression: null, background: null };

    // Gather all options
    const disabledConds = new Set(settings.disabledConditionals || []);
    const conditionalSprites = (settings.conditionalSprites || []).filter(cs => !disabledConds.has(cs.label));
    const conditionalBgs = settings.conditionalBackgrounds || [];
    const spriteLabels = await getAvailableLabels();
    const bgFilenames = settings.bgToolEnabled ? await fetchBackgroundsList() : [];

    if (spriteLabels.length === 0 && conditionalSprites.length === 0 && bgFilenames.length === 0) {
        return { expression: null, background: null };
    }

    // Build ALL possible labels (labels + conditional labels) for the tool enum
    const conditionalSpriteLabels = conditionalSprites.map(cs => getDisplayLabel(cs.label));
    const allSpriteOptions = [...new Set([...spriteLabels, ...conditionalSpriteLabels])].sort();
    const conditionalBgFilenames = conditionalBgs.map(cb => cb.filename);
    const allBgOptions = [...new Set([...bgFilenames, ...conditionalBgFilenames])].sort();

    setSidecarActive(true);

    try {
        // Build tools with ALL options in enum
        const tools = buildSelectionTools(allSpriteOptions, allBgOptions, settings.bgToolEnabled);

        // Get current state for context (if setting enabled)
        let currentExpression = null;
        let currentBackground = null;
        if (settings.showCurrentState) {
            const recentWithExpr = [...(context.chat || [])].reverse().find(m => m.extra?.bunmoji_expression);
            const recentWithBg = [...(context.chat || [])].reverse().find(m => m.extra?.bunmoji_background);
            currentExpression = recentWithExpr?.extra?.bunmoji_expression || null;
            currentBackground = recentWithBg?.extra?.bunmoji_background || null;
        }

        // Build prompt with conditional rules baked in
        const prompt = buildUnifiedPrompt({
            recentMessages,
            spriteLabels,
            conditionalSprites,
            conditionalBgs,
            bgFilenames,
            bgEnabled: settings.bgToolEnabled,
            currentExpression,
            currentBackground,
        });

        const systemPrompt = 'You are a visual director for a roleplay scene. Evaluate conditions, then pick the best expression and background. Keep reasoning to 1-2 sentences. You MUST call your assigned tools.';

        let result = { expression: null, background: null, expressionReasoning: null, backgroundReasoning: null };

        try {
            const { toolCalls, textContent } = await sidecarGenerateWithTools({ prompt, systemPrompt, tools });

            for (const tc of toolCalls) {
                if (tc.name === 'set_expression') {
                    const expr = String(tc.args?.expression || '').toLowerCase().trim();
                    if (expr && allSpriteOptions.includes(expr)) {
                        result.expression = expr;
                    } else if (expr) {
                        result.expression = fuzzyMatch(expr, allSpriteOptions);
                    }
                    result.expressionReasoning = tc.args?.reasoning || null;
                } else if (tc.name === 'set_background') {
                    const bg = String(tc.args?.background || '').trim();
                    if (bg && allBgOptions.includes(bg)) {
                        result.background = bg;
                    } else if (bg) {
                        result.background = fuzzyMatch(bg, allBgOptions);
                    }
                    result.backgroundReasoning = tc.args?.reasoning || null;
                }
            }

            // Text fallback if tool calls empty
            if (!result.expression && textContent) {
                const parsed = parseResponse(textContent, allSpriteOptions, allBgOptions);
                if (parsed.expression) result.expression = parsed.expression;
                if (!result.background && parsed.background) result.background = parsed.background;
            }
        } catch (e) {
            console.error('[BunMoji] Tool-calling failed:', e);

            // Full text fallback
            try {
                const fallbackPrompt = buildUnifiedPrompt({
                    recentMessages, spriteLabels, conditionalSprites, conditionalBgs,
                    bgFilenames, bgEnabled: settings.bgToolEnabled, jsonMode: true,
                });
                const response = await sidecarGenerate({ prompt: fallbackPrompt, systemPrompt: 'Respond ONLY with valid JSON.' });
                result = parseResponse(response, allSpriteOptions, allBgOptions);
            } catch (e2) {
                console.error('[BunMoji] Text fallback also failed:', e2);
                addFeedItem({ type: 'error', label: e2.message || 'Sidecar fallback failed' });
            }
        }

        // Save to the user message that triggered this generation (it exists right now)
        if (result.expression) saveToMetadata('bunmoji_expression', result.expression);
        if (result.background) saveToMetadata('bunmoji_background', result.background);

        if (result.expression) {
            await restoreExpression(result.expression);
            // Set ST's fallback expression to our pick so moduleWorker doesn't overwrite us
            if (extension_settings.expressions) {
                extension_settings.expressions.fallback_expression = resolveFileLabel(result.expression);
            }
            const isConditionalPick = conditionalSpriteLabels.includes(result.expression);
            console.log(`[BunMoji] Sidecar set expression: ${result.expression}${isConditionalPick ? ' (conditional)' : ''}`);
            addFeedItem({
                type: isConditionalPick ? 'conditional' : 'expression',
                label: result.expression,
                reasoning: result.expressionReasoning,
            });
        }

        if (result.background && settings.bgToolEnabled) {
            await applyBackground(result.background);
            console.log(`[BunMoji] Sidecar set background: ${result.background}`);
            addFeedItem({ type: 'background', label: result.background, reasoning: result.backgroundReasoning });
        }

        return result;
    } catch (e) {
        console.error('[BunMoji] Sidecar error:', e);
        addFeedItem({ type: 'error', label: e.message || 'Sidecar failed' });
        return { expression: null, background: null };
    } finally {
        setSidecarActive(false);
    }
}

// ─── Unified Prompt Builder ─────────────────────────────────────

/**
 * Build a single prompt that handles conditionals + selection.
 * The model evaluates conditions internally and picks accordingly.
 */
function buildUnifiedPrompt({ recentMessages, spriteLabels, conditionalSprites, conditionalBgs, bgFilenames, bgEnabled, jsonMode = false, currentExpression = null, currentBackground = null }) {
    let prompt = 'Current scene:\n' + recentMessages + '\n\n';

    // Show current state if available
    if (currentExpression || currentBackground) {
        prompt += 'Current state:';
        if (currentExpression) prompt += ` expression="${currentExpression}"`;
        if (currentBackground) prompt += ` background="${currentBackground}"`;
        prompt += '\nOnly change if the character\'s emotional state or scene location has meaningfully shifted.\n\n';
    }

    const hasCondSprites = conditionalSprites.length > 0;
    const hasCondBgs = conditionalBgs.length > 0;

    // Label expressions
    if (spriteLabels.length > 0) {
        prompt += `Label expressions (always available): ${spriteLabels.join(', ')}\n\n`;
    }

    // Conditional expressions with their condition groups
    if (hasCondSprites) {
        prompt += 'Conditional expressions (available ONLY if their conditions are met):\n';
        prompt += 'Condition types:\n';
        for (const [type, desc] of Object.entries(CONDITION_DESCRIPTIONS)) {
            prompt += `  ${type}: ${desc}\n`;
        }
        prompt += '  Prefix ! = condition should NOT be true\n\n';

        for (const cs of conditionalSprites) {
            const groups = cs.conditionGroups || [];
            const dl = getDisplayLabel(cs.label);
            if (groups.length === 0) {
                prompt += `  "${dl}" — no conditions (always available)\n`;
            } else {
                const groupStrs = groups.map((group, gi) => {
                    const conds = group.map(c => formatCondition(c)).join(' AND ');
                    return `Group ${gi + 1}: ${conds}`;
                }).join(' | ');
                prompt += `  "${dl}" — ${groupStrs}\n`;
                if (groups.length > 1) {
                    prompt += `    (ANY group passing = this conditional activates)\n`;
                }
            }
        }
        prompt += '\n';
    }

    // Priority rules
    if (hasCondSprites) {
        prompt += 'RULES for conditional expressions:\n';
        prompt += '1. For each conditional, evaluate its condition groups. A group passes when ALL its conditions are met.\n';
        prompt += '2. If ANY group passes, the conditional is activated.\n';
        prompt += '3. Negated conditions (prefixed !) pass when the state is NOT present.\n';
        prompt += '4. If one or more conditionals activate, prefer them over label expressions.\n';
        prompt += '5. If multiple conditionals activate, pick the best fit for the scene.\n';
        prompt += '6. If no conditionals activate, pick from label expressions.\n\n';
    }

    // Backgrounds
    if (bgEnabled && bgFilenames.length > 0) {
        prompt += `Available backgrounds: ${bgFilenames.join(', ')}\n`;
        if (hasCondBgs) {
            prompt += 'Conditional backgrounds:\n';
            for (const cb of conditionalBgs) {
                const groups = cb.conditionGroups || [];
                if (groups.length === 0) {
                    prompt += `  "${cb.filename}" — no conditions\n`;
                } else {
                    const groupStrs = groups.map((group, gi) => {
                        const conds = group.map(c => formatCondition(c)).join(' AND ');
                        return `Group ${gi + 1}: ${conds}`;
                    }).join(' | ');
                    prompt += `  "${cb.filename}" — ${groupStrs}\n`;
                }
            }
            prompt += 'Same rules apply: conditional backgrounds activate when ANY group passes.\n';
        }
        prompt += '\n';
    }

    // JSON mode instructions (text fallback)
    if (jsonMode) {
        prompt += 'Respond with JSON:\n{\n';
        prompt += '  "expression": "chosen_label",\n';
        prompt += '  "reasoning": "1-2 sentence reason"';
        if (bgEnabled && bgFilenames.length > 0) {
            prompt += ',\n  "background": "chosen_filename",\n';
            prompt += '  "bg_reasoning": "1-2 sentence reason"';
        }
        prompt += '\n}\n';
    } else {
        prompt += 'Pick the best expression';
        if (bgEnabled && bgFilenames.length > 0) prompt += ' and background';
        prompt += ' for this scene. Keep reasoning to 1-2 sentences.';
    }

    return prompt;
}

// ─── Tool Definitions ───────────────────────────────────────────

function buildSelectionTools(spriteLabels, bgFilenames, bgEnabled) {
    const tools = [];

    if (spriteLabels.length > 0) {
        tools.push({
            name: 'set_expression',
            description: `Set the character's expression. Pick the best fit for the current scene.`,
            parameters: {
                type: 'object',
                properties: {
                    expression: {
                        type: 'string',
                        description: 'The expression label to set.',
                        enum: spriteLabels,
                    },
                    reasoning: {
                        type: 'string',
                        description: '1-2 sentence reason for this pick.',
                    },
                },
                required: ['expression'],
            },
        });
    }

    if (bgEnabled && bgFilenames.length > 0) {
        tools.push({
            name: 'set_background',
            description: `Set the scene background. Pick the best match for the current location.`,
            parameters: {
                type: 'object',
                properties: {
                    background: {
                        type: 'string',
                        description: 'The background filename to set.',
                        enum: bgFilenames,
                    },
                    reasoning: {
                        type: 'string',
                        description: '1-2 sentence reason for this pick.',
                    },
                },
                required: ['background'],
            },
        });
    }

    return tools;
}

// ─── Text-Only Fallback Parser ──────────────────────────────────

function parseResponse(responseText, spriteLabels, bgFilenames) {
    const result = { expression: null, background: null };

    if (!responseText || typeof responseText !== 'string') return result;

    let text = responseText.trim().replace(/<think[\s\S]*?<\/think>/gi, '').trim();

    let parsed = tryParseJSON(text);

    if (parsed) {
        const expr = String(parsed.expression || parsed.expr || parsed.sprite || '').toLowerCase().trim();
        if (expr && spriteLabels.includes(expr)) {
            result.expression = expr;
        } else if (expr) {
            result.expression = fuzzyMatch(expr, spriteLabels);
        }

        const bg = String(parsed.background || parsed.bg || '').trim();
        if (bg && bgFilenames.includes(bg)) {
            result.background = bg;
        } else if (bg) {
            result.background = fuzzyMatch(bg, bgFilenames);
        }
    } else {
        // Plain text fallback — scan for known labels
        const words = text.toLowerCase().split(/\s+/);
        for (const word of words) {
            const cleaned = word.replace(/[^a-z0-9_-]/g, '');
            if (spriteLabels.includes(cleaned)) {
                result.expression = cleaned;
                break;
            }
        }
    }

    return result;
}

// ─── JSON Parsing Utilities ─────────────────────────────────────

function tryParseJSON(text) {
    try { return JSON.parse(text); } catch { /* continue */ }

    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
    }

    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
        const extracted = text.substring(braceStart, braceEnd + 1);
        try { return JSON.parse(extracted); } catch { /* continue */ }
        try { return JSON.parse(healJSON(extracted)); } catch { /* continue */ }
    }

    try { return JSON.parse(healJSON(text)); } catch { /* continue */ }

    return null;
}

function healJSON(text) {
    let s = text.trim();

    const start = s.indexOf('{');
    if (start > 0) s = s.substring(start);

    if (!s.includes('"') && s.includes("'")) {
        s = s.replace(/'/g, '"');
    }

    s = s.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    s = s.replace(/,\s*([}\]])/g, '$1');

    const opens = (s.match(/{/g) || []).length;
    const closes = (s.match(/}/g) || []).length;
    for (let i = closes; i < opens; i++) s += '}';

    const openBrackets = (s.match(/\[/g) || []).length;
    const closeBrackets = (s.match(/]/g) || []).length;
    for (let i = closeBrackets; i < openBrackets; i++) s += ']';

    return s;
}

// ─── Fuzzy Matching ─────────────────────────────────────────────

function fuzzyMatch(input, candidates) {
    if (!input || candidates.length === 0) return null;
    const lower = input.toLowerCase();

    const substringMatch = candidates.find(c => c.includes(lower) || lower.includes(c));
    if (substringMatch) return substringMatch;

    let bestDist = Infinity;
    let bestMatch = null;
    for (const candidate of candidates) {
        const dist = levenshtein(lower, candidate.toLowerCase());
        if (dist < bestDist && dist <= Math.max(3, candidate.length * 0.4)) {
            bestDist = dist;
            bestMatch = candidate;
        }
    }
    return bestMatch;
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}
