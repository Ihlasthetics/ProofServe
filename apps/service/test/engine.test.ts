import { describe, expect, it, vi } from 'vitest';
import { OpenAiTriageEngine, TriageEngineError } from '../src/engine.js';

const validResult = {
  category: 'account-access',
  urgency: 'high',
  summary: 'The customer cannot access their account.',
  suggestedAction: 'Verify account ownership and restore access.',
};

function modelResponse(output: unknown): Response {
  return new Response(
    JSON.stringify({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(output) }],
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('OpenAiTriageEngine', () => {
  it('uses the configured model and validates structured output', async () => {
    const fakeFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer fictional-key');
      const requestBody: unknown = JSON.parse(String(init?.body)) as unknown;
      expect(requestBody).toEqual(
        expect.objectContaining({
          model: 'configured-model',
          input: 'I cannot access my account.',
          store: false,
          text: {
            format: expect.objectContaining({
              type: 'json_schema',
              strict: true,
            }),
          },
        }),
      );
      return modelResponse(validResult);
    });
    const engine = new OpenAiTriageEngine({
      apiKey: 'fictional-key',
      model: 'configured-model',
      fetchImplementation: fakeFetch,
    });

    await expect(
      engine.triage({ ticket: 'I cannot access my account.' }),
    ).resolves.toEqual(validResult);
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.any(Object),
    );
  });

  it('rejects invalid model output instead of returning a fake result', async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () =>
      modelResponse({ ...validResult, urgency: 'critical' }),
    );
    const engine = new OpenAiTriageEngine({
      apiKey: 'fictional-key',
      model: 'configured-model',
      fetchImplementation: fakeFetch,
    });

    await expect(engine.triage({ ticket: 'Help' })).rejects.toBeInstanceOf(
      TriageEngineError,
    );
  });

  it('returns only a safe error when the provider fails', async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () =>
      Promise.reject(new Error('provider internals')),
    );
    const engine = new OpenAiTriageEngine({
      apiKey: 'do-not-expose',
      model: 'configured-model',
      fetchImplementation: fakeFetch,
    });

    await expect(engine.triage({ ticket: 'Help' })).rejects.toThrow(
      'Triage inference failed.',
    );
  });
});
