import {
  placeSearchValidator,
  visualExtractionValidator,
  type ImportReview,
  type VisualExtraction,
} from '@nextstop/core';
import type { VisionImage } from '@nextstop/model-gateway';
import type { RadarMap } from '../radar/amap.js';

export type ImportVision = (image: VisionImage) => Promise<VisualExtraction>;

export function emptyImageReview(id: string): ImportReview {
  return {
    import_id: id,
    revision: 1,
    source: { kind: 'image', import_id: id, excerpt: null },
    extraction: { kind: 'vision_unavailable' },
    match: { kind: 'not_searched' },
  };
}

export function createImportReview(
  map: RadarMap | null | undefined,
  vision: ImportVision | null | undefined,
) {
  async function match(query: string): Promise<ImportReview['match']> {
    if (!map) return { kind: 'map_unavailable' };
    try {
      const result = { places: await map.search(query.trim()) };
      if (!placeSearchValidator.check(result)) return { kind: 'map_unavailable' };
      const candidates = [...new Map(result.places.map((place) => [place.id, place])).values()];
      return { kind: 'results', candidates };
    } catch {
      return { kind: 'map_unavailable' };
    }
  }
  async function image(id: string, input: VisionImage): Promise<ImportReview> {
    const initial = emptyImageReview(id);
    if (!vision) return initial;
    let extraction: VisualExtraction;
    try {
      const result = await vision(input);
      if (!visualExtractionValidator.check(result)) return initial;
      extraction = result;
    } catch {
      return initial;
    }
    return {
      ...initial,
      source: {
        kind: 'image',
        import_id: id,
        excerpt: extraction.kind === 'text' ? extraction.excerpt : null,
      },
      extraction,
      match:
        extraction.kind === 'text' || extraction.kind === 'guess'
          ? await match(extraction.name)
          : initial.match,
    };
  }
  return { match, image };
}
