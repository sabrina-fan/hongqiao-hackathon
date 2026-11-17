export const taskCatalog = {
  'vision.extract': { transport: 'pi-ai', primary: 'zhipu', fallback: 'ark' },
  'reason.explain': { transport: 'pi-ai', primary: 'ark', fallback: 'zhipu' },
  'reason.plan': { transport: 'pi-ai', primary: 'ark', fallback: 'zhipu' },
  'fast.normalize': { transport: 'pi-ai', primary: 'ark', fallback: null },
  'fast.intent': { transport: 'systemone', primary: 'jev', fallback: 'ark' },
  'decision.poi_match': { transport: 'systemone', primary: 'jev', fallback: null },
  'decision.preferences': { transport: 'systemone', primary: 'jev', fallback: null },
  'decision.reason': { transport: 'systemone', primary: 'jev', fallback: null },
} satisfies Record<
  string,
  { transport: 'pi-ai' | 'systemone'; primary: string; fallback: string | null }
>;
export type TaskClass = keyof typeof taskCatalog;
