import { ISLAND_TERRAIN_DEPTH, ISLAND_TERRAIN_WIDTH } from '../player/movement';

/**
 * Signed distance field describing the playable island silhouette.
 *
 * Replaces the previous rectangular `abs(x) <= halfWidth` model with an organic
 * blob whose perimeter is a perturbed ellipse. The perturbation comes from three
 * sin terms at increasing frequencies of the polar angle — enough to read as a
 * natural island contour without ever folding back on itself.
 *
 * The single source of truth is `sampleIslandSDF(x, z)`. Everything else (beach
 * width, transitions, foam anchors, future SDF clamp on movement) is derived
 * from it. We pre-bake the result into `surfaceMaps.shoreDistanceMap` at boot so
 * the terrain shader does NOT evaluate the SDF per-fragment.
 *
 * Sign convention:
 *  - sdf < 0   ⇒ inland; |sdf| is the world distance to the nearest shore
 *  - sdf > 0   ⇒ offshore; sdf is the world distance to the nearest shore
 *  - sdf = 0   ⇒ exactly on the shoreline
 *
 * Radii are picked so the island fits inside the existing PlaneGeometry terrain
 * (94 × 78 m): a comfortable margin lets the perturbation grow outward without
 * exceeding the mesh.
 */

/**
 * Radii match the playable terrain bounds (94 × 78 m). The perturbation pulls the
 * shoreline inward by up to ~10% so the silhouette reads as organic without folding
 * back on itself, while the cliff plateau (north-west quadrant) stays comfortably
 * inside the island.
 */
const ISLAND_RADIUS_X = 44;
const ISLAND_RADIUS_Z = 36;

/** Soft transition zone width inside the island where sand fades into grass. */
const BEACH_TRANSITION_METERS = 10;

export interface IslandShape {
  /**
   * 0 inland, ramps to 1 right at the shoreline (and stays at 1 offshore). Drives
   * the sand splat weight and the wet-sand effect on the terrain shader.
   */
  beachT: number;
  /** True when (x, z) sits inside the island silhouette. */
  isLand: boolean;
  /** Signed distance: < 0 inland, > 0 offshore. */
  sdf: number;
  /** Distance to the nearest shoreline point (always non-negative). */
  shoreDistance: number;
}

export function sampleIslandSDF(x: number, z: number): number {
  const angle = Math.atan2(z, x);
  // Multi-octave perturbation of the radial multiplier. Amplitudes kept small (max
  // total ~0.12) so the cliff plateau in the NW quadrant stays comfortably inland
  // while the east/south coast still shows a curved, non-rectangular silhouette.
  const perturbation = computePerturbation(angle);
  const rx = ISLAND_RADIUS_X * perturbation;
  const rz = ISLAND_RADIUS_Z * perturbation;
  const nx = x / rx;
  const nz = z / rz;
  // Approximate ellipse SDF: scaled normalized distance. Not metric-perfect but
  // monotonically correct, which is all the consumers need for soft transitions.
  const innerDistance = Math.sqrt(nx * nx + nz * nz) - 1;
  return innerDistance * Math.min(rx, rz);
}

export function sampleIslandShape(x: number, z: number): IslandShape {
  const sdf = sampleIslandSDF(x, z);
  // Step 2 façade: `isLand` STAYS analytical (continuous SDF) so the splat bake
  // and the splat shader's offshore-discard agree on the shoreline. The grid
  // quantizes LAND/OCEAN at 1 m, which would expose strips of sand/grass mesh
  // along the cell boundary near the analytical shoreline. Step 3 unifies both
  // via the grid-derived `shoreDistanceMap` and this analytical SDF goes away.
  const isLand = sdf <= 0;
  const shoreDistance = Math.abs(sdf);

  const beachT = isLand
    ? Math.min(1, Math.max(0, 1 - shoreDistance / BEACH_TRANSITION_METERS))
    : 1;

  return { beachT, isLand, sdf, shoreDistance };
}

/**
 * Outward-pointing shoreline normal at (x, z), via central differences on the SDF.
 * Used by the wave system to orient lobe-shaped foam meshes along the coast.
 */
export function getIslandNormal(x: number, z: number): { x: number; z: number } {
  const epsilon = 0.5;
  const dx = sampleIslandSDF(x + epsilon, z) - sampleIslandSDF(x - epsilon, z);
  const dz = sampleIslandSDF(x, z + epsilon) - sampleIslandSDF(x, z - epsilon);
  const length = Math.sqrt(dx * dx + dz * dz);
  if (length < 1e-4) return { x: 1, z: 0 };
  return { x: dx / length, z: dz / length };
}

export interface ShoreAnchor {
  /** World-space X / Z of the anchor on the island shoreline. */
  x: number;
  z: number;
  /** Outward-pointing unit normal (away from the island). */
  normalX: number;
  normalZ: number;
  /** Tangent unit vector along the shore (90° CCW from normal). */
  tangentX: number;
  tangentZ: number;
}

/**
 * Sample `count` anchors along the shoreline (SDF = 0), evenly distributed by polar
 * angle around the island center. For each anchor we resolve the exact shoreline
 * position analytically from the perturbed ellipse equation, then derive the outward
 * normal via central differences and the tangent by 90° rotation.
 *
 * Used by `beachWaveSystem` to place individual wave lobes; iterating by angle keeps
 * sample density roughly proportional to the local circumference, giving even visual
 * spacing of waves around the island.
 */
export function sampleShoreAnchors(count: number): ShoreAnchor[] {
  const anchors: ShoreAnchor[] = [];

  for (let i = 0; i < count; i += 1) {
    const angle = ((i + 0.5) / count) * Math.PI * 2;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const perturbation = computePerturbation(angle);
    const rx = ISLAND_RADIUS_X * perturbation;
    const rz = ISLAND_RADIUS_Z * perturbation;

    // Solve r² · ((cosA / rx)² + (sinA / rz)²) = 1 for r along the (cosA, sinA) ray.
    const denom = (cosA * cosA) / (rx * rx) + (sinA * sinA) / (rz * rz);
    const r = 1 / Math.sqrt(denom);
    const x = r * cosA;
    const z = r * sinA;

    const normal = getIslandNormal(x, z);
    anchors.push({
      x,
      z,
      normalX: normal.x,
      normalZ: normal.z,
      tangentX: -normal.z,
      tangentZ: normal.x,
    });
  }

  return anchors;
}

function computePerturbation(angle: number): number {
  return (
    1
    + 0.06 * Math.sin(angle * 3 + 0.4)
    + 0.04 * Math.sin(angle * 6 + 1.7)
    + 0.025 * Math.sin(angle * 11 + 2.9)
  );
}

export const ISLAND_SHAPE = {
  RADIUS_X: ISLAND_RADIUS_X,
  RADIUS_Z: ISLAND_RADIUS_Z,
  BEACH_TRANSITION_METERS,
  /** Maximum world distance any sample on the rectangular terrain mesh can reach. */
  MAX_SHORE_DISTANCE_METERS: Math.max(
    ISLAND_TERRAIN_WIDTH,
    ISLAND_TERRAIN_DEPTH,
  ) * 0.5,
} as const;
