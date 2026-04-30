import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  // Serve the project's `assets/` directory as static, so e.g.
  //   /glb/characters/chibi_v4_base.glb  →  Z:/Islebound/assets/glb/characters/chibi_v4_base.glb
  //   /anims/walking.glb                 →  Z:/Islebound/assets/anims/walking.glb
  publicDir: 'assets',
});
