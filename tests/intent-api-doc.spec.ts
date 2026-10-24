import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntentSchema } from '@/lib/intent/offramp';

describe('Intent API documentation', () => {
  it('first jsonc/json request example under Endpoint satisfies IntentSchema', () => {
    const root = process.cwd();
    const docPath = join(root, 'docs', 'INTENT_API.md');
    const docContent = readFileSync(docPath, 'utf8');

    // Extract section under "## Endpoint"
    const endpointSectionMatch = docContent.match(/## Endpoint[\s\S]*?(?=\r?\n## |$)/);
    expect(endpointSectionMatch).toBeTruthy();

    const endpointSection = endpointSectionMatch![0];

    // Extract first ```json or ```jsonc code block
    const codeBlockMatch = endpointSection.match(/```jsonc?\r?\n([\s\S]*?)\r?\n```/);
    expect(codeBlockMatch).toBeTruthy();
    const rawJson = codeBlockMatch?.[1] ?? '';

    // Strip comments and trailing commas
    const strippedJson = rawJson
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/,(\s*[}\]])/g, '$1');

    const parsed = JSON.parse(strippedJson);
    const result = IntentSchema.safeParse(parsed);

    expect(result.success).toBe(true);
  });
});
