import { PrivacyShield } from './sanitizer.js';
export class AdvisorEngine {
    /**
     * Formats the problem into a high-yield prompt for the frontier browser AI.
     */
    static buildAdvisorPrompt(req) {
        const mode = req.mode || (req.error || req.code ? 'debug' : 'direct');
        let prompt = '';
        if (mode === 'direct') {
            prompt = req.task;
            if (req.code && req.code.trim()) {
                const lang = req.language || 'text';
                prompt += `\n\n## CODE CONTEXT:\n\`\`\`${lang}\n${req.code.trim()}\n\`\`\``;
            }
            if (req.error && req.error.trim()) {
                prompt += `\n\n## ERROR / OBSTACLE:\n\`\`\`\n${req.error.trim()}\n\`\`\``;
            }
        }
        else if (mode === 'code_only') {
            prompt = `TASK:\n${req.task}\n\n`;
            if (req.code && req.code.trim()) {
                const lang = req.language || 'text';
                prompt += `CODE:\n\`\`\`${lang}\n${req.code.trim()}\n\`\`\`\n\n`;
            }
            if (req.error && req.error.trim()) {
                prompt += `ERROR:\n\`\`\`\n${req.error.trim()}\n\`\`\`\n\n`;
            }
            prompt += `INSTRUCTION: Output ONLY the production code solution. Do NOT include greetings, conversational filler, diagnosis, or explanations.`;
        }
        else if (mode === 'debug') {
            prompt = `You are an Expert Senior Software Architect and Debugger.\n`;
            prompt += `A local AI coding assistant is implementing the following task and requires your guidance:\n\n`;
            prompt += `## TASK OBJECTIVE:\n${req.task}\n\n`;
            if (req.error && req.error.trim().length > 0) {
                prompt += `## ERROR / OBSTACLE ENCOUNTERED:\n\`\`\`\n${req.error.trim()}\n\`\`\`\n\n`;
            }
            if (req.code && req.code.trim().length > 0) {
                const lang = req.language || 'text';
                prompt += `## CURRENT CODE:\n\`\`\`${lang}\n${req.code.trim()}\n\`\`\`\n\n`;
            }
            prompt += `## REQUIRED OUTPUT STRUCTURE:\n`;
            prompt += `1. **DIAGNOSIS**: Explain the root cause of the error or bottleneck in 2-3 clear sentences.\n`;
            prompt += `2. **ACTIONABLE FIX**: What exact changes are required?\n`;
            prompt += `3. **PRODUCTION CODE SOLUTION**: Provide the complete, drop-in replacement code block with 100% symbol precision.\n`;
        }
        else {
            prompt = req.task;
            if (req.code && req.code.trim()) {
                const lang = req.language || 'text';
                prompt += `\n\n## CODE:\n\`\`\`${lang}\n${req.code.trim()}\n\`\`\``;
            }
            if (req.error && req.error.trim()) {
                prompt += `\n\n## ERROR:\n\`\`\`\n${req.error.trim()}\n\`\`\``;
            }
        }
        if (req.guardrails && req.guardrails.trim().length > 0) {
            prompt += `\n\n## USER GUARDRAILS & INSTRUCTIONS:\n${req.guardrails.trim()}`;
        }
        return prompt;
    }
    /**
     * Extracts clean code blocks from the browser AI response.
     */
    static extractCodeBlocks(markdown) {
        const codeBlockRegex = /```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
        const blocks = [];
        let match;
        while ((match = codeBlockRegex.exec(markdown)) !== null) {
            if (match[1] && match[1].trim().length > 0) {
                blocks.push(match[1].trim());
            }
        }
        return blocks;
    }
    /**
     * Runs the full advisor pipeline: Packaging -> Privacy Shield -> Browser AI -> Extraction.
     */
    static async consultAdvisor(tabManager, req) {
        const rawPrompt = this.buildAdvisorPrompt(req);
        // 1. Run through Privacy & Redaction Shield
        const sanitized = PrivacyShield.sanitize(rawPrompt);
        console.log(`[Advisor] 🛡️ Privacy Shield scrubbed ${sanitized.redactedCount} items (${sanitized.redactionsSummary.join(', ') || 'clean'})`);
        // 2. Dispatch to Browser AI
        const result = await tabManager.executePrompt(sanitized.cleanText, req.provider || 'auto');
        if (!result.success) {
            return {
                success: false,
                provider: result.provider,
                advice: '',
                extractedCodeBlocks: [],
                durationMs: result.durationMs,
                redactedSummary: sanitized.redactionsSummary,
                error: result.error || 'Browser AI failed to respond',
            };
        }
        // 3. Extract code blocks for easy 1-click copy or IDE insertion
        const codeBlocks = this.extractCodeBlocks(result.reply);
        return {
            success: true,
            provider: result.provider,
            advice: result.reply,
            extractedCodeBlocks: codeBlocks,
            durationMs: result.durationMs,
            redactedSummary: sanitized.redactionsSummary,
        };
    }
}
