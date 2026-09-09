import { readFile } from 'node:fs/promises';
import { TriageResultSchema } from '@proofserve/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiTriageEngine, TriageEngineError } from '../src/engine.js';

const validResult = {
  category: 'account-access',
  urgency: 'high',
  summary: 'The customer cannot access their account.',
  suggestedAction: 'Verify account ownership and restore access.',
} as const;

const expectedSchema = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
    suggestedAction: { type: 'string' },
  },
  required: ['category', 'urgency', 'summary', 'suggestedAction'],
  additionalProperties: false,
};

function modelResponse(output: unknown): Response {
  return new Response(
    JSON.stringify({
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'text',
              text:
                typeof output === 'string' ? output : JSON.stringify(output),
            },
          ],
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GeminiTriageEngine', () => {
  it('uses the configured model and schema and returns shared-schema-valid structured output', async () => {
    const apiKey = 'fictional-sensitive-key';
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const requestBodyText = String(init?.body);
      const requestBody: unknown = JSON.parse(requestBodyText) as unknown;

      expect(url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/interactions',
      );
      expect(new URL(url).search).toBe('');
      expect(headers.get('x-goog-api-key')).toBe(apiKey);
      expect(headers.get('authorization')).toBeNull();
      expect(url).not.toContain(apiKey);
      expect(requestBodyText).not.toContain(apiKey);
      expect(requestBodyText).not.toContain('minLength');
      expect(requestBodyText).not.toContain('maxLength');
      expect(requestBody).toEqual(
        expect.objectContaining({
          model: 'configured-model',
          input: 'I cannot access my account.',
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: expectedSchema,
          },
          generation_config: {
            max_output_tokens: 500,
          },
          store: false,
        }),
      );
      return modelResponse(validResult);
    });
    const engine = new GeminiTriageEngine({
      apiKey,
      model: 'configured-model',
      fetchImplementation: fakeFetch,
    });

    const result = await engine.triage({
      ticket: 'I cannot access my account.',
    });

    expect(result).toEqual(validResult);
    expect(TriageResultSchema.safeParse(result).success).toBe(true);
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['malformed JSON', 'not-json'],
    ['shared-schema-invalid JSON', { ...validResult, urgency: 'critical' }],
  ])('rejects %s instead of returning a fake result', async (_name, output) => {
    const engine = new GeminiTriageEngine({
      apiKey: 'fictional-placeholder',
      model: 'configured-model',
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        modelResponse(output),
      ),
    });

    await expect(engine.triage({ ticket: 'Help' })).rejects.toEqual(
      new TriageEngineError(),
    );
  });

  it.each([
    ['empty category', { ...validResult, category: '' }],
    ['oversized category', { ...validResult, category: 'x'.repeat(121) }],
    ['empty summary', { ...validResult, summary: '' }],
    ['oversized summary', { ...validResult, summary: 'x'.repeat(1001) }],
    ['empty suggested action', { ...validResult, suggestedAction: '' }],
    [
      'oversized suggested action',
      { ...validResult, suggestedAction: 'x'.repeat(2001) },
    ],
  ])('rejects %s through the shared result schema', async (_name, output) => {
    expect(TriageResultSchema.safeParse(output).success).toBe(false);
    const engine = new GeminiTriageEngine({
      apiKey: 'fictional-placeholder',
      model: 'configured-model',
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        modelResponse(output),
      ),
    });

    await expect(engine.triage({ ticket: 'Help' })).rejects.toEqual(
      new TriageEngineError(),
    );
  });

  it('returns only a safe error when Gemini fails', async () => {
    const apiKey = 'fictional-sensitive-key';
    const sentinel = 'SENSITIVE_GEMINI_PROVIDER_RESPONSE';
    const engine = new GeminiTriageEngine({
      apiKey,
      model: 'configured-model',
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        Promise.reject(new Error(`${sentinel}:${apiKey}`)),
      ),
    });

    let caught: unknown;
    try {
      await engine.triage({ ticket: 'Help' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new TriageEngineError());
    expect(String(caught)).not.toContain(sentinel);
    expect(String(caught)).not.toContain(apiKey);
  });

  it('does not expose a failed Gemini response body', async () => {
    const sentinel = 'SENSITIVE_GEMINI_RESPONSE_BODY';
    const engine = new GeminiTriageEngine({
      apiKey: 'fictional-placeholder',
      model: 'configured-model',
      fetchImplementation: vi.fn<typeof fetch>(
        async () => new Response(sentinel, { status: 503 }),
      ),
    });

    await expect(engine.triage({ ticket: 'Help' })).rejects.toEqual(
      new TriageEngineError(),
    );
  });

  it('sanitizes an HTTP 200 response with a non-JSON body', async () => {
    const sentinel = 'SENSITIVE_NON_JSON_GEMINI_BODY';
    const engine = new GeminiTriageEngine({
      apiKey: 'fictional-placeholder',
      model: 'configured-model',
      fetchImplementation: vi.fn<typeof fetch>(
        async () =>
          new Response(sentinel, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    });

    let caught: unknown;
    try {
      await engine.triage({ ticket: 'Help' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new TriageEngineError());
    expect(String(caught)).not.toContain(sentinel);
  });

  it('rejects structured output that contains the Gemini API key', async () => {
    const apiKey = 'fictional-sensitive-key';
    const engine = new GeminiTriageEngine({
      apiKey,
      model: 'configured-model',
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        modelResponse({ ...validResult, suggestedAction: apiKey }),
      ),
    });

    let caught: unknown;
    try {
      await engine.triage({ ticket: 'Help' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new TriageEngineError());
    expect(String(caught)).not.toContain(apiKey);
  });

  it('enforces the 30-second timeout and fails safely', async () => {
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    const fakeFetch = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('SENSITIVE_TIMEOUT_INTERNALS')),
            { once: true },
          );
        }),
    );
    const engine = new GeminiTriageEngine({
      apiKey: 'fictional-placeholder',
      model: 'configured-model',
      fetchImplementation: fakeFetch,
    });

    const triagePromise = engine.triage({ ticket: 'Help' });
    controller.abort();

    await expect(triagePromise).rejects.toEqual(new TriageEngineError());
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it('has neither an OpenAI dependency nor an OpenAI production endpoint', async () => {
    const packageJson = await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    const engineSource = await readFile(
      new URL('../src/engine.ts', import.meta.url),
      'utf8',
    );

    expect(packageJson.toLowerCase()).not.toContain('openai');
    expect(engineSource).not.toContain('api.openai.com');
    expect(engineSource).not.toContain('/v1/responses');
  });
});
