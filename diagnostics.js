/**
 * BunMoji Diagnostics
 * Checks for common configuration issues and provides fixes.
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';
import { getSettings, findConnectionProfile } from './index.js';
import { isSidecarKeyAvailable } from './llm-sidecar.js';

// Default ST expressions that do not need to be in extension_settings.expressions.custom
const DEFAULT_EXPRESSIONS = [
    'admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring',
    'confusion', 'curiosity', 'desire', 'disappointment', 'disapproval', 'disgust',
    'embarrassment', 'excitement', 'fear', 'gratitude', 'grief', 'joy', 'love',
    'nervousness', 'optimism', 'pride', 'realization', 'relief', 'remorse',
    'sadness', 'surprise', 'neutral',
];

const MODULE_NAME = 'BunMoji';

/**
 * @typedef {Object} DiagnosticResult
 * @property {'pass'|'warn'|'fail'} status
 * @property {string} label
 * @property {string} detail
 * @property {string} [fix] - Optional fix description
 */

/**
 * Run all diagnostics and return results.
 * @returns {Promise<DiagnosticResult[]>}
 */
export async function runDiagnostics() {
    const results = [];
    const settings = getSettings();

    // 1. Extension enabled
    results.push({
        status: settings.enabled ? 'pass' : 'warn',
        label: 'Extension Enabled',
        detail: settings.enabled ? 'BunMoji is enabled.' : 'BunMoji is disabled.',
        fix: settings.enabled ? null : 'Toggle "Enable BunMoji" on.',
    });

    // 2. ST Expressions classifier suppressed
    if (settings.enabled) {
        const api = extension_settings.expressions?.api;
        results.push({
            status: api === 99 ? 'pass' : 'warn',
            label: 'ST Classifier Suppressed',
            detail: api === 99
                ? 'ST\'s built-in expression classifier is suppressed (API = None).'
                : `ST\'s classifier is still active (API = ${api}). It may overwrite BunMoji expressions.`,
            fix: api === 99 ? null : 'This should auto-suppress when BunMoji is enabled. Try toggling BunMoji off and on.',
        });
    }

    // 3. Active character has sprites
    const context = getContext();
    const charName = context.name2;
    if (charName) {
        try {
            const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(charName)}`, {
                headers: getRequestHeaders(),
            });
            const sprites = res.ok ? await res.json() : [];
            const labels = [...new Set(sprites.map(s => s.label))];
            results.push({
                status: labels.length > 0 ? 'pass' : 'fail',
                label: 'Character Sprites',
                detail: labels.length > 0
                    ? `Found ${labels.length} expression(s) for "${charName}": ${labels.slice(0, 8).join(', ')}${labels.length > 8 ? '...' : ''}`
                    : `No sprites found for "${charName}".`,
                fix: labels.length > 0 ? null : `Upload sprite images to "data/characters/${charName}/" or use the drop zone above.`,
            });
        } catch {
            results.push({
                status: 'fail',
                label: 'Character Sprites',
                detail: 'Failed to fetch sprite list from server.',
            });
        }
    } else {
        results.push({
            status: 'warn',
            label: 'Character Sprites',
            detail: 'No active character. Start a chat to check sprites.',
        });
    }

    // 4. Expressions extension loaded
    const expressionsLoaded = typeof extension_settings.expressions === 'object';
    results.push({
        status: expressionsLoaded ? 'pass' : 'fail',
        label: 'Expressions Extension',
        detail: expressionsLoaded
            ? 'ST\'s Expressions extension is loaded.'
            : 'ST\'s Expressions extension is not loaded. BunMoji requires it for sprite rendering.',
        fix: expressionsLoaded ? null : 'Enable the Expressions (Sprites) extension in ST\'s Extensions menu.',
    });

    // 5. Sidecar configuration (REQUIRED for all functionality)
    if (settings.enabled) {
        if (!settings.connectionProfile) {
            results.push({
                status: 'fail',
                label: 'Sidecar Profile',
                detail: 'No sidecar connection profile is set. BunMoji requires a sidecar to function.',
                fix: 'Select a connection profile under the Sidecar dropdown.',
            });
        } else {
            const profile = findConnectionProfile(settings.connectionProfile);
            if (!profile) {
                results.push({
                    status: 'fail',
                    label: 'Sidecar Profile',
                    detail: `Connection profile "${settings.connectionProfile}" not found in Connection Manager.`,
                    fix: 'Select a valid connection profile or create one in Connection Manager.',
                });
            } else if (!profile.api || !profile.model) {
                results.push({
                    status: 'fail',
                    label: 'Sidecar Profile',
                    detail: `Connection profile "${profile.name}" is incomplete (missing API or model).`,
                    fix: 'Edit the profile in Connection Manager and set both API source and model.',
                });
            } else {
                results.push({
                    status: 'pass',
                    label: 'Sidecar Profile',
                    detail: `Sidecar configured: ${profile.name} (${profile.api}/${profile.model}).`,
                });
            }
        }

        // 6. API key accessibility
        if (!isSidecarKeyAvailable()) {
            results.push({
                status: 'fail',
                label: 'API Key Access',
                detail: 'Secret key access denied (403). allowKeysExposure is not enabled.',
                fix: 'Set "allowKeysExposure: true" in SillyTavern\'s config.yaml and restart ST.',
            });
        } else if (settings.connectionProfile) {
            results.push({
                status: 'pass',
                label: 'API Key Access',
                detail: 'Secret key access is available.',
            });
        }
    }

    // 7. Conditional sprites validation
    for (let i = 0; i < (settings.conditionalSprites || []).length; i++) {
        const cs = settings.conditionalSprites[i];
        if (!cs.label) {
            results.push({
                status: 'fail',
                label: `Conditional #${i + 1}`,
                detail: 'Conditional sprite has no label.',
                fix: 'Remove or edit this conditional sprite.',
            });
        }
        const csGroups = cs.conditionGroups || [];
        const csHasConditions = csGroups.some(g => g.length > 0);
        if (!csHasConditions) {
            results.push({
                status: 'warn',
                label: `Conditional "${cs.label || '#' + (i + 1)}"`,
                detail: 'No conditions set -- this conditional will never activate.',
                fix: 'Add at least one condition or remove this conditional.',
            });
        }
    }

    // 7b. Conditional backgrounds validation
    for (let i = 0; i < (settings.conditionalBackgrounds || []).length; i++) {
        const cb = settings.conditionalBackgrounds[i];
        if (!cb.filename) {
            results.push({
                status: 'fail',
                label: `Conditional BG #${i + 1}`,
                detail: 'Conditional background has no filename.',
                fix: 'Remove or edit this conditional background.',
            });
        }
        const cbGroups = cb.conditionGroups || [];
        const cbHasConditions = cbGroups.some(g => g.length > 0);
        if (!cbHasConditions) {
            results.push({
                status: 'warn',
                label: `Conditional BG "${cb.filename || '#' + (i + 1)}"`,
                detail: 'No conditions set -- this conditional background will never activate.',
                fix: 'Add at least one condition or remove this conditional background.',
            });
        }
    }

    // 8. Custom expressions registered
    // Non-default sprite labels must be in extension_settings.expressions.custom
    // so ST's expression system can route them correctly.
    if (charName && expressionsLoaded) {
        try {
            const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(charName)}`, {
                headers: getRequestHeaders(),
            });
            const sprites = res.ok ? await res.json() : [];
            const allLabels = [...new Set(sprites.map(s => s.label))];
            const nonDefaultLabels = allLabels.filter(l => !DEFAULT_EXPRESSIONS.includes(l));
            const customRegistered = Array.isArray(extension_settings.expressions?.custom)
                ? extension_settings.expressions.custom
                : [];
            const unregistered = nonDefaultLabels.filter(l => !customRegistered.includes(l));

            if (nonDefaultLabels.length === 0) {
                results.push({
                    status: 'pass',
                    label: 'Custom Expressions Registered',
                    detail: 'All sprite labels are standard ST expressions -- no custom registration needed.',
                });
            } else if (unregistered.length === 0) {
                results.push({
                    status: 'pass',
                    label: 'Custom Expressions Registered',
                    detail: `All ${nonDefaultLabels.length} non-default label(s) are registered in ST's custom expressions list.`,
                });
            } else {
                results.push({
                    status: 'warn',
                    label: 'Custom Expressions Registered',
                    detail: `${unregistered.length} sprite label(s) are not registered in ST's custom expressions: ${unregistered.join(', ')}. They may not display correctly.`,
                    fix: 'Open the Expressions extension, click "Add Expression", and register each missing label.',
                });
            }
        } catch {
            results.push({
                status: 'warn',
                label: 'Custom Expressions Registered',
                detail: 'Could not fetch sprites to verify custom expression registration.',
            });
        }
    }

    // 9. Disabled sprite labels (info)
    {
        const disabledLabels = settings.disabledLabels || [];
        if (disabledLabels.length > 0) {
            results.push({
                status: 'pass',
                label: 'Disabled Sprite Labels',
                detail: `${disabledLabels.length} label(s) are disabled and will be excluded from sidecar selection: ${disabledLabels.join(', ')}.`,
            });
        } else {
            results.push({
                status: 'pass',
                label: 'Disabled Sprite Labels',
                detail: 'No sprite labels are disabled. All available labels will be offered to the sidecar.',
            });
        }
    }

    // 10. Label aliases (info)
    {
        const aliases = settings.labelAliases || {};
        const aliasCount = Object.keys(aliases).length;
        if (aliasCount > 0) {
            results.push({
                status: 'pass',
                label: 'Label Aliases',
                detail: `${aliasCount} label alias(es) configured. The sidecar sees alias names; file labels are used internally.`,
            });
        } else {
            results.push({
                status: 'pass',
                label: 'Label Aliases',
                detail: 'No label aliases configured. Sidecar uses raw file label names.',
            });
        }
    }

    return results;
}
