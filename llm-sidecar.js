/**
 * BunMoji LLM Sidecar
 * Direct API calls to LLM providers for conditional sprite evaluation.
 * Bypasses ST's generateRaw to give BunMoji full control over its own samplers.
 *
 * Reads provider, model, and endpoint from a Connection Manager profile, then
 * fetches the API key from ST's secrets store. The user never has to configure
 * anything beyond picking a profile.
 */

import { getContext } from '../../../st-context.js';
import { getSettings, findConnectionProfile } from './index.js';

const MODULE_NAME = 'BunMoji';

// ─── Provider Mapping ───────────────────────────────────────────────

let _secretKeyFailed = false;

const PROVIDER_MAP = {
    openai:       { format: 'openai',    endpoint: 'https://api.openai.com/v1/chat/completions',              secretKey: 'api_key_openai' },
    claude:       { format: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages',                   secretKey: 'api_key_claude' },
    openrouter:   { format: 'openai',    endpoint: 'https://openrouter.ai/api/v1/chat/completions',           secretKey: 'api_key_openrouter' },
    makersuite:   { format: 'google',    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',  secretKey: 'api_key_makersuite' },
    deepseek:     { format: 'openai',    endpoint: 'https://api.deepseek.com/v1/chat/completions',            secretKey: 'api_key_deepseek' },
    mistralai:    { format: 'openai',    endpoint: 'https://api.mistral.ai/v1/chat/completions',              secretKey: 'api_key_mistralai' },
    custom:       { format: 'openai',    endpoint: null,                                                       secretKey: 'api_key_custom' },
    nanogpt:      { format: 'openai',    endpoint: 'https://nano-gpt.com/api/v1/chat/completions',            secretKey: 'api_key_nanogpt' },
    groq:         { format: 'openai',    endpoint: 'https://api.groq.com/openai/v1/chat/completions',         secretKey: 'api_key_groq' },
    chutes:       { format: 'openai',    endpoint: 'https://llm.chutes.ai/v1/chat/completions',               secretKey: 'api_key_chutes' },
    electronhub:  { format: 'openai',    endpoint: 'https://api.electronhub.ai/v1/chat/completions',          secretKey: 'api_key_electronhub' },
    xai:          { format: 'openai',    endpoint: 'https://api.x.ai/v1/chat/completions',                    secretKey: 'api_key_xai' },
};

/**
 * Look up provider info from a profile's `api` field.
 * Falls back to OpenAI-compatible format for unknown providers.
 */
function getProviderInfo(apiSource) {
    return PROVIDER_MAP[apiSource] || { format: 'openai', endpoint: null, secretKey: null };
}

// ─── Secret Key Fetching ────────────────────────────────────────────

/**
 * Fetch an API key from SillyTavern's secrets system.
 * Requires allowKeysExposure: true in ST's config.yaml.
 * @param {string} secretKey - The secret key identifier (e.g. 'api_key_openai')
 * @returns {Promise<string|null>} The API key or null if unavailable
 */
export async function fetchSecretKey(secretKey) {
    if (!secretKey) {
        console.warn(`[${MODULE_NAME}] fetchSecretKey called with no key identifier`);
        return null;
    }
    if (_secretKeyFailed) {
        return null;
    }

    try {
        const response = await fetch('/api/secrets/find', {
            method: 'POST',
            headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ key: secretKey }),
        });

        if (!response.ok) {
            if (response.status === 403) {
                _secretKeyFailed = true;
                console.warn(`[${MODULE_NAME}] Secret key access DENIED (403). allowKeysExposure is NOT enabled in config.yaml. Sidecar disabled for this session.`);
            } else {
                console.warn(`[${MODULE_NAME}] Secret key fetch failed: HTTP ${response.status} for "${secretKey}"`);
            }
            return null;
        }

        const data = await response.json();
        return data.value || null;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error fetching secret key "${secretKey}":`, error);
        return null;
    }
}

/**
 * Returns false when the circuit breaker has been tripped by a 403 from /api/secrets/find.
 * @returns {boolean}
 */
export function isSidecarKeyAvailable() {
    return !_secretKeyFailed;
}

// ─── Think Block Stripping ──────────────────────────────────────────

const THINK_BLOCK_RE = /<think[\s\S]*?<\/think>/gi;

// ─── Main Sidecar Generate ──────────────────────────────────────────

/**
 * Check whether the sidecar is configured (a connection profile is selected).
 * @returns {boolean}
 */
export function isSidecarConfigured() {
    if (_secretKeyFailed) {
        return false;
    }
    const settings = getSettings();
    const profileId = settings.connectionProfile;
    if (!profileId) {
        return false;
    }
    const profile = findConnectionProfile(profileId);
    if (!profile) {
        return false;
    }
    return !!(profile.api && profile.model);
}

/**
 * Get the resolved sidecar model display string (e.g. "nanogpt/deepseek-chat").
 * Returns null if sidecar is not configured.
 * @returns {string|null}
 */
export function getSidecarModelLabel() {
    const config = resolveProfileConfig();
    if (!config) return null;
    return `${config.provider}/${config.model}`;
}

/**
 * Resolve the connection profile into everything needed for a direct API call.
 * @returns {{ provider: string, format: string, model: string, endpoint: string, secretKey: string|null }|null}
 */
function resolveProfileConfig() {
    const settings = getSettings();
    const profileId = settings.connectionProfile;
    if (!profileId) return null;

    const profile = findConnectionProfile(profileId);
    if (!profile?.api || !profile?.model) return null;

    const info = getProviderInfo(profile.api);

    let endpoint = info.endpoint || profile['api-url'] || null;
    if (!info.endpoint && endpoint && info.format === 'openai' && !endpoint.endsWith('/chat/completions')) {
        endpoint = endpoint.replace(/\/+$/, '') + '/chat/completions';
    }

    return {
        provider: profile.api,
        format: info.format,
        model: profile.model,
        endpoint,
        secretKey: info.secretKey,
    };
}

/**
 * Generate text via direct API call, bypassing ST's generateRaw.
 * Reads provider/model/endpoint from the selected Connection Manager profile.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The user/main prompt text
 * @param {string} [opts.systemPrompt] - Optional system prompt
 * @returns {Promise<string>} The generated text (think blocks stripped)
 * @throws {Error} On missing config, missing API key, or API errors
 */
export async function sidecarGenerate({ prompt, systemPrompt }) {
    const config = resolveProfileConfig();
    if (!config) {
        throw new Error('Sidecar not configured: no valid connection profile selected.');
    }

    const settings = getSettings();
    const temperature = settings.sidecarTemperature ?? 0.2;
    const maxTokens = settings.sidecarMaxTokens || 1024;

    const { provider, format, model, endpoint, secretKey } = config;

    if (!endpoint) {
        throw new Error(`No endpoint found for provider "${provider}". Set a Server URL in the connection profile.`);
    }

    const apiKey = await fetchSecretKey(secretKey);
    if (!apiKey) {
        throw new Error(
            `No API key found for "${provider}". Add your key in SillyTavern's API settings and ensure allowKeysExposure is enabled in config.yaml.`,
        );
    }

    let result;

    if (format === 'anthropic') {
        result = await _callAnthropic({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
    } else if (format === 'google') {
        result = await _callGoogle({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
    } else {
        result = await _callOpenAI({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, provider });
    }

    const cleaned = typeof result === 'string' ? result.replace(THINK_BLOCK_RE, '').trim() : result;
    return cleaned;
}

// ─── Provider-Specific Callers ──────────────────────────────────────

/**
 * Anthropic Claude API
 */
async function _callAnthropic({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens }) {
    const requestBody = {
        model,
        max_tokens: maxTokens,
        system: systemPrompt || '',
        messages: [{ role: 'user', content: prompt }],
        temperature,
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        let errorText = await response.text().catch(() => 'Unable to read error');
        if (errorText.length > 300) errorText = errorText.substring(0, 300) + '... (truncated)';
        throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.content && Array.isArray(data.content)) {
        const textBlock = data.content.find(block => block.type === 'text');
        return textBlock?.text || '';
    }
    return '';
}

/**
 * Google AI Studio (Gemini) API
 */
async function _callGoogle({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens }) {
    const googleEndpoint = `${endpoint}/${model}:generateContent`;

    const fullPrompt = systemPrompt
        ? `${systemPrompt}\n\n---\n\n${prompt}`
        : prompt;

    const requestBody = {
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
        ],
        contents: [
            { role: 'user', parts: [{ text: fullPrompt }] },
        ],
        generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
        },
    };

    const response = await fetch(googleEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        let errorText = await response.text().catch(() => 'Unable to read error');
        if (errorText.length > 300) errorText = errorText.substring(0, 300) + '... (truncated)';
        throw new Error(`Google AI Studio API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
    }
    return '';
}

/**
 * OpenAI-compatible API (OpenAI, OpenRouter, DeepSeek, Groq, custom, etc.)
 */
async function _callOpenAI({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, provider }) {
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    if (provider === 'openrouter') {
        headers['HTTP-Referer'] = window.location.origin;
        headers['X-Title'] = 'BunMoji';
    }

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const requestBody = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        let errorText = await response.text().catch(() => 'Unable to read error');
        if (errorText.length > 300) errorText = errorText.substring(0, 300) + '... (truncated)';
        throw new Error(`${provider} API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.choices?.[0]?.message?.content) {
        return data.choices[0].message.content;
    }
    return '';
}

// ─── Tool-Calling Sidecar Generate ──────────────────────────────

/**
 * Generate with tool calling via direct API call.
 * Uses native tool_use (Anthropic) or function calling (OpenAI-compat).
 * Falls back to text generation for Google.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The user prompt
 * @param {string} [opts.systemPrompt] - System prompt
 * @param {Array} opts.tools - Tool definitions in a neutral format
 * @returns {Promise<{toolCalls: Array<{name: string, args: Object}>, textContent: string}>}
 */
export async function sidecarGenerateWithTools({ prompt, systemPrompt, tools }) {
    const config = resolveProfileConfig();
    if (!config) throw new Error('Sidecar not configured.');

    const settings = getSettings();
    const temperature = settings.sidecarTemperature ?? 0.2;
    const maxTokens = settings.sidecarMaxTokens || 1024;

    const { provider, format, model, endpoint, secretKey } = config;
    if (!endpoint) throw new Error(`No endpoint for "${provider}".`);

    const apiKey = await fetchSecretKey(secretKey);
    if (!apiKey) throw new Error(`No API key for "${provider}".`);

    if (format === 'google') {
        // Google: fall back to text generation, caller handles JSON parsing
        const text = await _callGoogle({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
        const cleaned = typeof text === 'string' ? text.replace(THINK_BLOCK_RE, '').trim() : '';
        return { toolCalls: [], textContent: cleaned };
    }

    // Anthropic or OpenAI-compatible — use real tool calling with retry
    const callFn = format === 'anthropic'
        ? () => _callAnthropicWithTools({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, tools })
        : () => _callOpenAIWithTools({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, provider, tools });

    const result = await callFn();
    const calledNames = new Set(result.toolCalls.map(tc => tc.name));
    const requestedNames = tools.map(t => t.name);
    const missingTools = requestedNames.filter(n => !calledNames.has(n));

    // Retry once if the model only called some tools (common with smaller models)
    if (missingTools.length > 0 && result.toolCalls.length > 0) {
        const retryTools = tools.filter(t => missingTools.includes(t.name));
        const retryPrompt = `${prompt}\n\nYou already set: ${result.toolCalls.map(tc => tc.name).join(', ')}. Now call the remaining tool(s).`;

        try {
            const retryCallFn = format === 'anthropic'
                ? () => _callAnthropicWithTools({ endpoint, apiKey, model, systemPrompt, prompt: retryPrompt, temperature, maxTokens, tools: retryTools })
                : () => _callOpenAIWithTools({ endpoint, apiKey, model, systemPrompt, prompt: retryPrompt, temperature, maxTokens, provider, tools: retryTools });

            const retryResult = await retryCallFn();

            // Merge retry results (dedup already handled inside callers)
            for (const tc of retryResult.toolCalls) {
                if (!calledNames.has(tc.name)) {
                    result.toolCalls.push(tc);
                    calledNames.add(tc.name);
                }
            }
            if (retryResult.textContent && !result.textContent) {
                result.textContent = retryResult.textContent;
            }
        } catch (e) {
            console.warn(`[${MODULE_NAME}] Retry for missing tools failed:`, e.message);
            // Non-fatal — we still have the first call's results
        }
    }

    return result;
}

// ─── Tool-Calling Provider Callers ──────────────────────────────

/**
 * Anthropic Claude API with tool calling.
 * Sends tools with tool_choice: { type: "any" }, parses content[].type === "tool_use" blocks.
 */
async function _callAnthropicWithTools({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, tools }) {
    const anthropicTools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
    }));

    const requestBody = {
        model,
        max_tokens: maxTokens,
        system: systemPrompt || '',
        messages: [{ role: 'user', content: prompt }],
        tools: anthropicTools,
        tool_choice: { type: 'any' },
        temperature,
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        let errorText = await response.text().catch(() => 'Unable to read error');
        if (errorText.length > 300) errorText = errorText.substring(0, 300) + '...';
        throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const toolCalls = [];
    let textContent = '';
    const calledNames = new Set();

    if (data.content && Array.isArray(data.content)) {
        for (const block of data.content) {
            if (block.type === 'tool_use' && !calledNames.has(block.name)) {
                calledNames.add(block.name);
                toolCalls.push({ name: block.name, args: block.input || {} });
            } else if (block.type === 'text') {
                textContent += block.text;
            }
        }
    }

    return { toolCalls, textContent: textContent.replace(THINK_BLOCK_RE, '').trim() };
}

/**
 * OpenAI-compatible API with tool calling.
 * Sends tools with tool_choice: "required", parses message.tool_calls[].
 * Works with OpenAI, OpenRouter, DeepSeek, Groq, and other compatible providers.
 */
async function _callOpenAIWithTools({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, provider, tools }) {
    const openaiTools = tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        },
    }));

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    if (provider === 'openrouter') {
        headers['HTTP-Referer'] = window.location.origin;
        headers['X-Title'] = 'BunMoji';
    }

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const requestBody = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        tools: openaiTools,
        tool_choice: 'required',
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        let errorText = await response.text().catch(() => 'Unable to read error');
        if (errorText.length > 300) errorText = errorText.substring(0, 300) + '...';
        throw new Error(`${provider} API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const toolCalls = [];
    let textContent = '';
    const calledNames = new Set();

    const message = data.choices?.[0]?.message;
    if (message?.tool_calls && Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
            if (tc.type === 'function' && tc.function && !calledNames.has(tc.function.name)) {
                calledNames.add(tc.function.name);
                let parsedArgs = {};
                try {
                    parsedArgs = JSON.parse(tc.function.arguments);
                } catch {
                    parsedArgs = { value: tc.function.arguments };
                }
                toolCalls.push({ name: tc.function.name, args: parsedArgs });
            }
        }
    }

    if (message?.content) {
        textContent = message.content;
    }

    return { toolCalls, textContent: textContent.replace(THINK_BLOCK_RE, '').trim() };
}
