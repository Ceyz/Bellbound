# Bellbound Lab

Prototype Three.js local pour tester rapidement des scenes, controles et rendus.

## Stack

- Vite pour le serveur de dev et le build.
- TypeScript pour garder les prototypes solides.
- Three.js pour le rendu 3D.
- lil-gui pour ajuster les parametres pendant les tests.
- Vitest pour les tests rapides de logique scene.
- Playwright pour les futurs smoke tests navigateur, avec les binaires forces dans `.ms-playwright`.

## Commandes

```powershell
npm run dev
npm test
npm run build
npm run test:e2e:install
npm run test:e2e
```

La config npm locale garde le cache et le prefix dans `Z:/Islebound` via `.npmrc`.
