import { ISLAND_TERRAIN_DEPTH, ISLAND_TERRAIN_WIDTH } from '../player/movement';
import { HEIGHTMAP, getIslandHeight, isInRiver, isOnCliff, riverCenterZ } from './heightmap';
import { sampleIslandShape } from './islandShape';

export type SurfaceKind = 'grass' | 'sand' | 'dirt' | 'riverbed' | 'cliff' | 'void';

export type SurfaceSplatChannel = 'grass' | 'sand' | 'dirt' | 'cliff';

export interface SurfaceSplatWeights {
  grass: number;
  sand: number;
  dirt: number;
  cliff: number;
}

export interface SurfaceClassification {
  altitude: number;
  beachBlend: number;
  cliffEdge: number;
  inRiver: boolean;
  /**
   * Distance (m) from this point to the nearest shoreline, derived from the SDF.
   * Always non-negative. Use `isInIsland` to know which side of the shore we're on.
   */
  shoreDistance: number;
  islandShore: number;
  isBeach: boolean;
  isFullySand: boolean;
  /** True when (x, z) sits inside the SDF island silhouette. */
  isInIsland: boolean;
  isPath: boolean;
  kind: SurfaceKind;
  onCliff: boolean;
  shore: number;
  splat: SurfaceSplatWeights;
  riverBank: number;
  worldX: number;
  worldZ: number;
}

export const SURFACE_SPLAT_CHANNELS: Record<SurfaceSplatChannel, 'r' | 'g' | 'b' | 'a'> = {
  grass: 'r',
  sand: 'g',
  dirt: 'b',
  cliff: 'a',
};

const TERRAIN_HALF_WIDTH = ISLAND_TERRAIN_WIDTH / 2;
const TERRAIN_HALF_DEPTH = ISLAND_TERRAIN_DEPTH / 2;

/**
 * Single source of truth for the island's visual surface classification.
 *
 * The RGBA splat packing intentionally keeps only four channels:
 * R grass, G sand, B dirt/riverbed, A cliff top. Riverbed remains a distinct
 * semantic `kind`, but currently shares the dirt splat channel until a second
 * splat texture is worth the extra shader cost.
 */
export function classifySurfaceAt(worldX: number, worldZ: number): SurfaceClassification {
  const shape = sampleIslandShape(worldX, worldZ);
  const isInIsland = shape.isLand;
  const shoreDistance = shape.shoreDistance;

  // beachBlend is now a continuous SDF-driven function: 0 deep inland, 1 at and
  // beyond the shore. The transition zone is `BEACH_TRANSITION_METERS` wide.
  const beachBlend = shape.beachT;

  const inRiver = isInIsland && isInRiver(worldX, worldZ);
  const onCliff = isInIsland && !inRiver && isOnCliff(worldX, worldZ);
  // Hardcoded paths to the (now-removed) house and shop were dropped during the
  // terraforming refactor scene cleanup; players will paint paths via the path
  // tool once Step 7 ships.
  const isPath = false;
  const isBeach = isInIsland && !inRiver && beachBlend >= 0.5;
  // Match `getSurfaceKind`'s sand threshold so anywhere the surface kind reads
  // "sand" the gameplay also considers it sand for footprint spawning.
  const isFullySand = isInIsland && !inRiver && beachBlend >= 0.4;

  const kind: SurfaceKind = !isInIsland
    ? 'void'
    : getSurfaceKind({ beachBlend, inRiver, isPath, onCliff });
  const splat = getSplatWeights(kind, beachBlend);

  const cliffEdge = isInIsland ? getCliffEdgeStrength(worldX, worldZ, onCliff) : 0;
  const riverBank = isInIsland ? getRiverBankStrength(worldX, worldZ) : 0;
  const islandShore = getIslandShoreStrength(shoreDistance, isInIsland);
  const shore = Math.max(riverBank, islandShore);

  return {
    altitude: getIslandHeight(worldX, worldZ),
    beachBlend,
    cliffEdge,
    inRiver,
    shoreDistance,
    islandShore,
    isBeach,
    isFullySand,
    isInIsland,
    isPath,
    kind,
    onCliff,
    shore,
    splat,
    riverBank,
    worldX,
    worldZ,
  };
}

export function isOnSand(worldX: number, worldZ: number): boolean {
  return classifySurfaceAt(worldX, worldZ).isFullySand;
}

export function surfaceWeightAt(
  worldX: number,
  worldZ: number,
  channel: SurfaceSplatChannel,
): number {
  return classifySurfaceAt(worldX, worldZ).splat[channel];
}

function getSurfaceKind(surface: {
  beachBlend: number;
  inRiver: boolean;
  isPath: boolean;
  onCliff: boolean;
}): Exclude<SurfaceKind, 'void'> {
  if (surface.inRiver) return 'riverbed';
  // Sand kind threshold tuned for the wider BEACH_TRANSITION_METERS = 6 zone:
  // 0.4 corresponds to ~3.6 m of shoreDistance, matching the visible sand band.
  if (surface.beachBlend >= 0.4) return 'sand';
  if (surface.isPath) return 'dirt';
  if (surface.onCliff) return 'cliff';
  return 'grass';
}

/**
 * Splat weights are continuous in the beach transition zone so the grass↔sand
 * boundary follows the curved shoreline instead of a hard binary edge. Outside the
 * transition (deep inland, fully on sand, on path/cliff/river) the split stays
 * categorical so cliffs and paths read as crisply as before.
 *
 * The grass↔sand curve uses a tightened smoothstep [0.30, 0.55] rather than the raw
 * `beachBlend`. Effect on a 3 m beach band:
 *  - shoreDistance > 2.1 m  ⇒ pure grass
 *  - shoreDistance ≈ 1.4 m  ⇒ 50/50 transition
 *  - shoreDistance < 1.35 m ⇒ pure sand (≈ 1.5 m wide visible band, the ACNH look)
 */
function getSplatWeights(kind: SurfaceKind, beachBlend: number): SurfaceSplatWeights {
  if (kind === 'void') return { grass: 0, sand: 0, dirt: 0, cliff: 0 };
  if (kind === 'cliff') return { grass: 0, sand: 0, dirt: 0, cliff: 1 };
  if (kind === 'dirt' || kind === 'riverbed') return { grass: 0, sand: 0, dirt: 1, cliff: 0 };

  const sandWeight = smoothstep(beachBlend, 0.3, 0.55);
  return { grass: 1 - sandWeight, sand: sandWeight, dirt: 0, cliff: 0 };
}

function getCliffEdgeStrength(
  worldX: number,
  worldZ: number,
  onCliff: boolean,
) {
  if (!onCliff) return 0;

  const distanceToEastEdge = HEIGHTMAP.CLIFF_X_MAX - worldX;
  const distanceToSouthEdge = HEIGHTMAP.CLIFF_Z_MAX - worldZ;
  const distanceToExposedEdge = Math.min(distanceToEastEdge, distanceToSouthEdge);

  return 1 - smoothstep(distanceToExposedEdge, 0.15, 1.25);
}

function getRiverBankStrength(worldX: number, worldZ: number) {
  if (worldX < HEIGHTMAP.RIVER_X_MIN - 0.8 || worldX > HEIGHTMAP.RIVER_X_MAX + 0.8) return 0;
  if (worldZ < HEIGHTMAP.RIVER_Z_MIN - 0.8 || worldZ > HEIGHTMAP.RIVER_Z_MAX + 0.8) return 0;

  const distanceFromCenter = Math.abs(worldZ - riverCenterZ(worldX));
  const distanceToBank = Math.abs(distanceFromCenter - HEIGHTMAP.RIVER_HALF_WIDTH);

  return 1 - smoothstep(distanceToBank, 0.05, 1.25);
}

function getIslandShoreStrength(shoreDistance: number, isInIsland: boolean) {
  if (!isInIsland) return 0;
  // Foam ribbon and wet-sand effects fade in as we approach the shore. Width tuned
  // so the band is visible without bleeding into deep inland zones.
  return 1 - smoothstep(shoreDistance, 0.2, 2.4);
}

function smoothstep(value: number, min: number, max: number) {
  if (value <= min) return 0;
  if (value >= max) return 1;

  const t = (value - min) / (max - min);
  return t * t * (3 - 2 * t);
}
