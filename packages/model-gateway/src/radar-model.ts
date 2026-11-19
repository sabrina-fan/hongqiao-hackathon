import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type Model,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';

export type RadarModel = ReturnType<typeof createRadarModel>;
export const RADAR_MODEL_TIMEOUT_DETAIL = 'Radar model time budget exhausted';

export function createRadarModel({
  modelId,
  baseUrl,
  apiKey,
}: {
  modelId: string;
  baseUrl: string;
  apiKey: string;
}) {
  const provider = 'nextstop-radar';
  const models = createModels();
  const model: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    provider,
    api: 'openai-completions',
    baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 16_384,
    maxTokens: 512,
    compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  };
  models.setProvider(
    createProvider({
      id: provider,
      models: [model],
      api: openAICompletionsApi(),
      auth: { apiKey: { name: 'Radar API key', resolve: async () => ({ auth: { apiKey } }) } },
    }),
  );
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (target, context, options) => {
    const [offered, extra] = getCurrentTools(context.messages);
    // Query and proposal get 6s + 9s, leaving room between 15s map recall and the 32s client timeout.
    const budget = AbortSignal.timeout(
      !extra && offered?.name === 'candidates_propose' ? 9000 : 6000,
    );
    // This signal bounds the whole stream, including the body after headers.
    const signal = options?.signal ? AbortSignal.any([options.signal, budget]) : budget;
    const upstream = stream(target, context, {
      ...options,
      signal,
      maxRetries: 0,
      maxTokens: 512,
      cacheRetention: 'none',
    });
    const result = createAssistantMessageEventStream();
    // Durable 1.5.2 schedules the entire terminal tool batch. Release no partial calls.
    void upstream
      .result()
      .then((message) => {
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          const timedOut =
            message.stopReason === 'aborted' && budget.aborted && signal.reason === budget.reason;
          result.push({
            type: 'error',
            reason: message.stopReason,
            error: {
              ...message,
              content: [],
              errorMessage: timedOut ? RADAR_MODEL_TIMEOUT_DETAIL : 'Radar model unavailable',
            },
          });
          return;
        }
        const [call, another] = message.content.filter((part) => part.type === 'toolCall');
        const accepted =
          message.stopReason === 'toolUse' &&
          offered &&
          !extra &&
          call &&
          !another &&
          call.name === offered.name;
        const terminal = accepted
          ? { ...message, content: [call] }
          : { ...message, content: [], stopReason: 'stop' as const };
        result.push({ type: 'start', partial: { ...terminal, content: [] } });
        result.push({ type: 'done', reason: accepted ? 'toolUse' : 'stop', message: terminal });
      })
      .catch(() =>
        result.push({
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            api: target.api,
            provider: target.provider,
            model: target.id,
            content: [],
            timestamp: Date.now(),
            stopReason: 'error',
            errorMessage: 'Radar model unavailable',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        }),
      );
    return result;
  };
  return { models, ref: { provider, modelId } };
}

export function configuredRadarModel(env: NodeJS.ProcessEnv) {
  const apiKey = env.ARK_API_KEY?.trim();
  const modelId = env.ARK_MODEL_TEXT?.trim();
  const url = URL.parse(env.ARK_BASE_URL?.trim() ?? '');
  if (
    !apiKey ||
    /^x+$/i.test(apiKey) ||
    !modelId ||
    url?.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  return createRadarModel({ modelId, apiKey, baseUrl: url.href.replace(/\/$/, '') });
}
