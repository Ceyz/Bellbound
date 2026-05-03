import { sampleIslandSDF } from '../islandShape';
import { BEACH_LOWER_OFFSET_METERS, BEACH_RADIUS_CELLS } from './TerrainGrid';

export const SMOOTH_BEACH_TOP_INSET_METERS = BEACH_RADIUS_CELLS + 0.55;
export const SMOOTH_BEACH_SLOPE_WIDTH_METERS = 0.62;
export const SMOOTH_BEACH_BOTTOM_INSET_METERS =
  SMOOTH_BEACH_TOP_INSET_METERS - SMOOTH_BEACH_SLOPE_WIDTH_METERS;
export const SMOOTH_BEACH_Y_OFFSET = 0.02;
export const SMOOTH_BEACH_SAMPLE_COUNT = 256;

export function smoothBeachInlandDistance(worldX: number, worldZ: number): number {
  return -sampleIslandSDF(worldX, worldZ);
}

export function smoothBeachHeightAt(worldX: number, worldZ: number): number {
  const d = smoothBeachInlandDistance(worldX, worldZ);
  if (d <= SMOOTH_BEACH_BOTTOM_INSET_METERS) return -BEACH_LOWER_OFFSET_METERS;
  if (d >= SMOOTH_BEACH_TOP_INSET_METERS) return 0;
  const t = smoothstep(
    (d - SMOOTH_BEACH_BOTTOM_INSET_METERS)
    / (SMOOTH_BEACH_TOP_INSET_METERS - SMOOTH_BEACH_BOTTOM_INSET_METERS),
  );
  return -BEACH_LOWER_OFFSET_METERS * (1 - t);
}

export function isSmoothBeachSand(worldX: number, worldZ: number): boolean {
  return smoothBeachInlandDistance(worldX, worldZ) <= SMOOTH_BEACH_TOP_INSET_METERS;
}

export function isSmoothBeachSlope(worldX: number, worldZ: number): boolean {
  const d = smoothBeachInlandDistance(worldX, worldZ);
  return d > SMOOTH_BEACH_BOTTOM_INSET_METERS && d < SMOOTH_BEACH_TOP_INSET_METERS;
}

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}
