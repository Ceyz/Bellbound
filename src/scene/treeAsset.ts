import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyAcnhLighting } from './acnhLighting';
import { applyTreeSwayShaderTo } from './treeSway';
import { attachApplesToTree } from './appleSystem';

const TREE_GLB_URL = '/glb/environment/trees/Meshy_AI_Emerald_Canopy_Tree_0430055546_texture.glb';

/**
 * Target world height for an instantiated tree. The Meshy export is uniformly scaled to
 * fit, then the scale is BAKED into the geometry so `position.y` in the vertex shader is
 * in the same coordinate frame as the wind-sway mask thresholds (which assume base ≈ 0,
 * top ≈ 3 m).
 */
const TARGET_TREE_HEIGHT = 3.0;

interface TreeTemplate {
  /** A single Group whose children are flattened, bake-transformed Meshes. */
  group: THREE.Group;
}

let templatePromise: Promise<TreeTemplate> | null = null;

/**
 * Loads the tree GLB once and prepares a shared template. The template's meshes have
 * baked geometry transforms (no parent chain, no scale, base at y=0) so the sway mask
 * works in mesh-local space. Materials are patched with the wind-sway vertex shader and
 * with ACNH-style fragment lighting at template-load time, so every clone of the template
 * inherits both effects without re-patching.
 */
function loadTreeTemplate(): Promise<TreeTemplate> {
  if (templatePromise) return templatePromise;

  const loader = new GLTFLoader();
  templatePromise = loader.loadAsync(TREE_GLB_URL).then((gltf) => {
    const flattened = flattenAndBake(gltf.scene);

    const bbox = new THREE.Box3().setFromObject(flattened);
    const height = bbox.max.y - bbox.min.y;
    const scale = TARGET_TREE_HEIGHT / Math.max(height, 0.001);

    const transform = new THREE.Matrix4()
      .makeTranslation(-(bbox.min.x + bbox.max.x) / 2, -bbox.min.y, -(bbox.min.z + bbox.max.z) / 2)
      .premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));

    const patchedMaterials = new Set<THREE.MeshStandardMaterial>();
    flattened.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;

      obj.geometry.applyMatrix4(transform);
      obj.geometry.computeBoundingBox();
      obj.geometry.computeBoundingSphere();
      // NOTE: do NOT call `computeVertexNormals()` — Meshy ships smooth-shaded normals in the
      // GLB; recomputing flattens them per-face and ruins the canopy lighting.

      if (obj.material instanceof THREE.MeshStandardMaterial && !patchedMaterials.has(obj.material)) {
        // Meshy exports default to `metallicFactor: 1`. Without a scene environment map, fully
        // metallic surfaces have nothing to reflect and render as washed-out white/grey on
        // many GPUs (driver-dependent). Foliage is not metallic — force matte non-metallic so
        // the baseColorTexture diffuse drives the look. Roughness is slightly under 1.0 so a
        // hint of directional light specular keeps the canopy from reading as flat paper.
        obj.material.metalness = 0;
        obj.material.roughness = 0.92;
        // Disable the metallic-roughness texture override so the constants above apply.
        obj.material.metalnessMap = null;
        obj.material.roughnessMap = null;
        obj.material.needsUpdate = true;

        applyTreeSwayShaderTo(obj.material);
        applyAcnhLighting(obj.material);
        patchedMaterials.add(obj.material);
      }
    });

    return { group: flattened };
  });

  return templatePromise;
}

function flattenAndBake(gltfScene: THREE.Object3D): THREE.Group {
  const flattened = new THREE.Group();
  flattened.name = 'tree-template';
  gltfScene.updateMatrixWorld(true);
  gltfScene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const baked = obj.geometry.clone();
    baked.applyMatrix4(obj.matrixWorld);
    const newMesh = new THREE.Mesh(baked, obj.material);
    newMesh.name = obj.name || 'tree-part';
    newMesh.castShadow = true;
    newMesh.receiveShadow = true;
    flattened.add(newMesh);
  });
  return flattened;
}

/**
 * Returns a tree Group at `position`. The Group is created synchronously so collision and
 * rolling-world wiring (built around `tree.position`) works without waiting on the network.
 * The visual meshes are populated when the GLB load resolves; first call triggers the
 * load, subsequent calls reuse the cached promise.
 *
 * Each instance shares the template's geometry and material — Three.js compiles the shader
 * once, the GPU draws all instances with per-tree variation through the model matrix.
 */
export function createFruitTreeGroup(name: string, position: [number, number, number]): THREE.Group {
  const tree = new THREE.Group();
  tree.name = name;
  tree.position.set(...position);

  void loadTreeTemplate().then((template) => {
    template.group.children.forEach((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const inst = new THREE.Mesh(child.geometry, child.material);
      inst.name = `${name}-${child.name}`;
      inst.castShadow = true;
      inst.receiveShadow = true;
      // The sway shader displaces vertices and the rolling world translates the parent
      // group; both push effective AABB beyond the mesh's rest bbox, so disable culling.
      inst.frustumCulled = false;
      tree.add(inst);
    });
    attachApplesToTree(tree);
  });

  return tree;
}
