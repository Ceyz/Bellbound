import type { BuildItemInfo, BuildKind, BuildMode, BuildModeState } from './buildMode';

/**
 * ACNH-inspired build mode UI.
 *
 * Three visual states:
 *  - **Idle**: small floating "Construire" button bottom-right (FAB).
 *  - **Modal open**: centered "Décorer mon île" panel listing each available item
 *    with its current stock. Click an item with stock → closes the modal and starts
 *    placement. Items at stock 0 are disabled.
 *  - **Placing**: minimal status bar bottom-center ("Placement : <Item>" + "Annuler").
 *    The FAB is hidden during placement (you're already placing something).
 *
 * Stock decrements per placement (BuildMode.tryPlace handles the math). When the
 * last item of a kind is placed, BuildMode auto-exits placement mode (ACNH behavior).
 */
export function mountBuildModeUI(buildMode: BuildMode): HTMLElement {
  injectStyles();

  const root = document.createElement('div');
  root.className = 'build-ui';
  root.dataset.role = 'build-mode-ui';
  document.body.appendChild(root);

  const fab = createFAB(() => openModal());
  const modal = createModal(buildMode, () => closeModal());
  const statusBar = createStatusBar(() => buildMode.exit());

  root.appendChild(fab);
  root.appendChild(modal);
  root.appendChild(statusBar);

  let modalOpen = false;

  function openModal() {
    modalOpen = true;
    modal.classList.add('build-modal-open');
    fab.classList.add('build-hidden');
    refreshModalItems(modal, buildMode, () => closeModal());
  }

  function closeModal() {
    modalOpen = false;
    modal.classList.remove('build-modal-open');
    if (!buildMode.isActive()) fab.classList.remove('build-hidden');
  }

  buildMode.onChange((state: BuildModeState) => {
    // Always refresh item card stocks (modal might still be open if user opened then placing).
    refreshModalItems(modal, buildMode, () => closeModal());

    if (state.active) {
      fab.classList.add('build-hidden');
      modal.classList.remove('build-modal-open');
      modalOpen = false;
      statusBar.classList.add('build-status-visible');
      const label = statusBar.querySelector<HTMLElement>('.build-status-label');
      if (label && state.kind) {
        label.textContent = `Outil : ${buildMode.getLabel(state.kind)}`;
      }
    } else {
      statusBar.classList.remove('build-status-visible');
      if (!modalOpen) fab.classList.remove('build-hidden');
    }
  });

  // Click outside the modal closes it (idle state only).
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });

  // Escape closes modal (BuildMode handles Escape during placement separately).
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Escape' && modalOpen) {
      closeModal();
      event.preventDefault();
    }
  });

  // Initial state
  modal.classList.remove('build-modal-open');
  statusBar.classList.remove('build-status-visible');

  return root;
}

function createFAB(onOpen: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'build-fab';
  btn.title = 'Décorer mon île';

  // Inline SVG hammer/build icon — no emoji to keep style consistent.
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a1 1 0 0 1 0-1.4l1.6-1.6a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-1.6 1.6a1 1 0 0 1-1.4 0z"/>
      <path d="m18 9-9 9-3 1 1-3 9-9"/>
      <path d="M3 21h7"/>
    </svg>
    <span class="build-fab-label">Construire</span>
  `;

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    onOpen();
  });

  return btn;
}

function createModal(buildMode: BuildMode, onClose: () => void): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'build-modal-backdrop';

  const panel = document.createElement('div');
  panel.className = 'build-modal-panel';
  backdrop.appendChild(panel);

  const header = document.createElement('div');
  header.className = 'build-modal-header';
  header.textContent = 'Construction';
  panel.appendChild(header);

  const subtitle = document.createElement('div');
  subtitle.className = 'build-modal-subtitle';
  subtitle.textContent = 'Sélectionnez un outil.';
  panel.appendChild(subtitle);

  const grid = document.createElement('div');
  grid.className = 'build-modal-grid';
  panel.appendChild(grid);

  const footer = document.createElement('div');
  footer.className = 'build-modal-footer';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'build-btn build-btn-ghost';
  closeBtn.textContent = 'Fermer';
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    onClose();
  });
  footer.appendChild(closeBtn);
  panel.appendChild(footer);

  // Initial render of items
  refreshModalItems(backdrop, buildMode, onClose);

  return backdrop;
}

function refreshModalItems(modal: HTMLElement, buildMode: BuildMode, onClose: () => void) {
  const grid = modal.querySelector<HTMLElement>('.build-modal-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Group by category derived from the kind prefix. Order is fixed so the
  // user sees a stable layout regardless of registration order.
  const sections: Array<{ id: string; title: string; tools: BuildItemInfo[] }> = [
    { id: 'cliff', title: 'Falaise', tools: [] },
    { id: 'water', title: 'Eau', tools: [] },
    { id: 'path', title: 'Chemin', tools: [] },
  ];
  const sectionByKind = (kind: BuildKind): typeof sections[number] | null => {
    if (kind.startsWith('cliff_')) return sections[0];
    if (kind.startsWith('water_')) return sections[1];
    if (kind.startsWith('path_')) return sections[2];
    return null;
  };

  for (const item of buildMode.listItems()) {
    const target = sectionByKind(item.kind);
    if (target) target.tools.push(item);
  }

  for (const section of sections) {
    if (section.tools.length === 0) continue;
    const header = document.createElement('div');
    header.className = `build-modal-section-header build-section-${section.id}`;
    header.textContent = section.title;
    grid.appendChild(header);

    // Paths render as a dedicated AC-style palette (swatches with animated
    // tooltips on hover) rather than the standard icon+label cards. Cliff
    // and water stay as cards because they have only 2 tools each — a
    // labelled card reads better than a tooltip-only swatch when the
    // tools aren't visually self-evident from a color alone.
    if (section.id === 'path') {
      const palette = document.createElement('div');
      palette.className = 'build-path-palette';
      for (const item of section.tools) {
        palette.appendChild(
          createPathSwatch(item, () => {
            const stockGated = item.showStock !== false;
            if (stockGated && item.stock <= 0) return;
            buildMode.enter(item.kind);
            onClose();
          }),
        );
      }
      grid.appendChild(palette);
      continue;
    }

    const row = document.createElement('div');
    row.className = 'build-modal-section-row';
    for (const item of section.tools) {
      row.appendChild(
        createItemCard(item, () => {
          // Stock-gated tools (legacy props) require stock > 0 to enter mode.
          // Unlimited tools (terraforming, showStock === false) are always
          // enterable — their stock field is meaningless and stays at 0.
          const stockGated = item.showStock !== false;
          if (stockGated && item.stock <= 0) return;
          buildMode.enter(item.kind);
          onClose();
        }),
      );
    }
    grid.appendChild(row);
  }
}

/**
 * AC:NH-style path swatch. A colored square (no static label) that scales
 * up gently on hover, and reveals the path name in a floating tooltip
 * above with a soft bounce-in. No label is shown by default so the row
 * reads as "a paint palette" rather than "a list of named buttons" —
 * the tooltip discloses the name on demand.
 */
function createPathSwatch(item: BuildItemInfo, onClick: () => void): HTMLElement {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'build-path-swatch';
  swatch.dataset.kind = item.kind;
  swatch.title = ''; // suppress native tooltip; we render our own animated one
  swatch.innerHTML = renderItemVisual(item.kind);

  const tooltip = document.createElement('span');
  tooltip.className = 'build-path-tooltip';
  tooltip.textContent = pathTooltipName(item.kind, item.label);
  swatch.appendChild(tooltip);

  swatch.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });

  return swatch;
}

/**
 * Short name for the hover tooltip — strips the "Chemin " prefix that's
 * implicit in the section header so "Chemin pierre" reads as just "Pierre"
 * in the floating tooltip. The "Effacer chemin" tool keeps its full label
 * because there's no implicit shared prefix to strip.
 */
function pathTooltipName(kind: BuildKind, label: string): string {
  if (kind === 'path_erase') return 'Effacer';
  const stripped = label.replace(/^Chemin\s+/i, '');
  if (stripped.length === 0) return label;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function createItemCard(item: BuildItemInfo, onClick: () => void): HTMLElement {
  // AC:NH-inspired round icon button with a label below. The circle gets a
  // category-themed pastel background (different per tool) so the row reads
  // as a colorful palette of icons rather than a uniform list.
  const wrapper = document.createElement('div');
  wrapper.className = 'build-item-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `build-item-circle build-item-circle-${item.kind}`;
  const stockGated = item.showStock !== false;
  if (stockGated && item.stock <= 0) btn.classList.add('build-item-circle-disabled');
  btn.disabled = stockGated && item.stock <= 0;
  btn.innerHTML = renderItemVisual(item.kind);

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });

  wrapper.appendChild(btn);

  const label = document.createElement('div');
  label.className = 'build-item-label';
  label.textContent = item.label;
  wrapper.appendChild(label);

  if (stockGated) {
    const stock = document.createElement('div');
    stock.className = 'build-item-stock';
    stock.textContent = `× ${item.stock}`;
    wrapper.appendChild(stock);
  }

  return wrapper;
}

function renderItemVisual(kind: BuildKind): string {
  // Inline SVGs sized 46×46. Per-kind glyphs that read at a glance:
  //   cliff_raise/lower  — stepped silhouette + arrow direction
  //   water_dig/fill     — droplet with carve / refill arrow
  //   path_paint_*       — color swatch matching the in-shader tint
  //   path_erase         — generic eraser cross
  switch (kind) {
    case 'cliff_raise':
      return `
        <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
          <path d="M6 38 L18 38 L18 28 L30 28 L30 18 L42 18 L42 38 Z"
                fill="#caa37c" stroke="#7a5e44" stroke-width="2" stroke-linejoin="round"/>
          <path d="M14 14 L20 8 L26 14 M20 8 L20 24"
                fill="none" stroke="#3d8d4b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    case 'cliff_lower':
      return `
        <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
          <path d="M6 38 L18 38 L18 28 L30 28 L30 18 L42 18 L42 38 Z"
                fill="#caa37c" stroke="#7a5e44" stroke-width="2" stroke-linejoin="round"/>
          <path d="M14 18 L20 24 L26 18 M20 24 L20 8"
                fill="none" stroke="#b54a35" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    case 'water_dig':
      return `
        <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
          <path d="M6 30 Q12 26 18 30 T30 30 T42 30 L42 42 L6 42 Z"
                fill="#7ec8e3" stroke="#3d7c98" stroke-width="2" stroke-linejoin="round"/>
          <path d="M24 8 C24 8 14 18 14 25 C14 30 18 33 24 33 C30 33 34 30 34 25 C34 18 24 8 24 8 Z"
                fill="#5fb1cf" stroke="#2d6783" stroke-width="2" stroke-linejoin="round"/>
          <path d="M22 22 L26 26 M26 22 L22 26"
                fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
        </svg>`;
    case 'water_fill':
      return `
        <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
          <path d="M6 30 Q12 26 18 30 T30 30 T42 30 L42 42 L6 42 Z"
                fill="#caa37c" stroke="#7a5e44" stroke-width="2" stroke-linejoin="round"/>
          <path d="M24 8 C24 8 14 18 14 25 C14 30 18 33 24 33 C30 33 34 30 34 25 C34 18 24 8 24 8 Z"
                fill="#5fb1cf" stroke="#2d6783" stroke-width="2" stroke-linejoin="round"/>
          <path d="M24 36 L24 44 M20 40 L24 44 L28 40"
                fill="none" stroke="#3d8d4b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    case 'path_paint_dirt':
      return pathSwatchSvg('#a87a4f');
    case 'path_paint_stone':
      return pathSwatchSvg('#9e9e9e');
    case 'path_paint_brick':
      return pathSwatchSvg('#c64d3a');
    case 'path_paint_planks':
      return pathSwatchSvg('#c89150');
    case 'path_erase':
      return `
        <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
          <rect x="8" y="14" width="32" height="20" rx="4" fill="#e8d8c4" stroke="#7a5e44" stroke-width="2"/>
          <path d="M14 20 L34 20 M14 26 L34 26" stroke="#7a5e44" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 3"/>
          <path d="M12 12 L36 36 M36 12 L12 36"
                stroke="#b54a35" stroke-width="3" stroke-linecap="round"/>
        </svg>`;
    default:
      return `
        <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
          <rect x="10" y="10" width="28" height="28" rx="6" fill="#d4a878"/>
          <rect x="16" y="16" width="16" height="16" rx="3" fill="#fff8f0"/>
        </svg>`;
  }
}

function pathSwatchSvg(color: string): string {
  // Three short cobble-like rectangles laid in a strip — reads as "a path"
  // at a glance regardless of the swatch color.
  return `
    <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
      <rect x="6" y="14" width="36" height="20" rx="3" fill="${color}" stroke="#5a4530" stroke-width="2"/>
      <rect x="10" y="18" width="9" height="12" rx="1.5" fill="rgba(255,255,255,0.18)"/>
      <rect x="20" y="18" width="9" height="12" rx="1.5" fill="rgba(0,0,0,0.10)"/>
      <rect x="30" y="18" width="8" height="12" rx="1.5" fill="rgba(255,255,255,0.10)"/>
    </svg>
  `;
}

function createStatusBar(onCancel: () => void): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'build-status-bar';

  const label = document.createElement('span');
  label.className = 'build-status-label';
  label.textContent = '';
  bar.appendChild(label);

  const hint = document.createElement('span');
  hint.className = 'build-status-hint';
  hint.textContent = 'Ctrl+Z : annuler';
  bar.appendChild(hint);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'build-btn build-btn-cancel';
  cancel.textContent = 'Annuler';
  cancel.addEventListener('click', (event) => {
    event.stopPropagation();
    onCancel();
  });
  bar.appendChild(cancel);

  return bar;
}

function injectStyles() {
  if (document.querySelector('style[data-build-mode-styles]')) return;

  const style = document.createElement('style');
  style.setAttribute('data-build-mode-styles', '');
  style.textContent = `
    .build-ui {
      pointer-events: none;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #4a3828;
    }
    .build-hidden { display: none !important; }

    /* Floating action button */
    .build-fab {
      position: fixed;
      right: 20px;
      bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 18px 12px 14px;
      background: rgba(255, 248, 240, 0.97);
      border: 2px solid #c4956a;
      border-radius: 999px;
      color: #4a3828;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 6px 18px rgba(74, 56, 40, 0.28);
      font-size: 14px;
      font-weight: 600;
      transition: transform 0.1s ease, background 0.12s ease;
      z-index: 50;
    }
    .build-fab:hover { background: #f5ead8; }
    .build-fab:active { transform: translateY(1px); }
    .build-fab svg { color: #8c4030; }
    .build-fab-label { letter-spacing: 0.2px; }

    /* Modal backdrop + panel.
       Anchor to the LEFT side of the viewport (AC:NH-style island designer
       palette, which docks to a screen edge instead of taking over the
       full center). The dim backdrop still covers everything for click-to-
       dismiss, but the panel itself sits flush with the left margin so
       the player keeps a clear view of the island while picking a tool. */
    .build-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(74, 56, 40, 0.22);
      display: none;
      align-items: center;
      justify-content: flex-start;
      padding-left: 24px;
      z-index: 60;
      pointer-events: auto;
      backdrop-filter: blur(2px);
    }
    .build-modal-backdrop.build-modal-open { display: flex; }

    /* AC:NH-style "phone bubble" panel: very rounded pill ends, soft cream
       gradient, drop shadow that reads as floating UI. */
    .build-modal-panel {
      width: min(420px, calc(100vw - 32px));
      max-height: calc(100vh - 60px);
      overflow-y: auto;
      background: linear-gradient(180deg, #fff7e7 0%, #fbecd0 100%);
      border: 3px solid #e8d2a6;
      border-radius: 36px;
      padding: 22px 26px 18px;
      box-shadow:
        0 14px 36px rgba(74, 56, 40, 0.32),
        inset 0 -2px 0 rgba(180, 140, 90, 0.18);
    }
    .build-modal-header {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.4px;
      color: #4a3828;
      text-align: center;
      margin-bottom: 2px;
    }
    .build-modal-subtitle {
      font-size: 12px;
      color: #a48a6c;
      text-align: center;
      margin-bottom: 14px;
    }
    .build-modal-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 14px;
    }
    .build-modal-section-header {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #8c7060;
      padding: 2px 4px 4px;
      margin-top: 4px;
    }
    .build-modal-section-header.build-section-cliff { color: #7a5630; }
    .build-modal-section-header.build-section-water { color: #2d6783; }
    .build-modal-section-header.build-section-path  { color: #a8702a; }
    .build-modal-section-row {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      justify-content: flex-start;
      padding: 4px 4px 6px;
    }

    /* AC:NH-style path palette: pill-shaped sub-bubble with rounded square
       swatches inside. Reproduces the in-game "Stone path" picker layout. */
    .build-path-palette {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 14px 16px 28px; /* extra bottom room so the hovered tooltip never clips */
      background: linear-gradient(180deg, #fff7e2 0%, #f7e6c2 100%);
      border-radius: 999px;
      justify-content: center;
      box-shadow:
        inset 0 2px 4px rgba(255, 255, 255, 0.55),
        inset 0 -3px 6px rgba(180, 140, 90, 0.16),
        0 4px 10px rgba(74, 56, 40, 0.16);
    }
    .build-path-swatch {
      position: relative;
      width: 56px;
      height: 56px;
      padding: 0;
      background: #fff8f0;
      border: 2px solid #c4956a;
      border-radius: 14px;
      cursor: pointer;
      font-family: inherit;
      color: inherit;
      overflow: visible;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1),
                  box-shadow 0.18s ease,
                  border-color 0.18s ease;
    }
    .build-path-swatch:hover,
    .build-path-swatch:focus-visible {
      transform: translateY(-3px) scale(1.06);
      border-color: #f5b94a;
      box-shadow: 0 6px 14px rgba(74, 56, 40, 0.28);
      outline: none;
    }
    .build-path-swatch:active {
      transform: translateY(-1px) scale(1.03);
    }
    .build-path-swatch svg {
      width: 44px;
      height: 44px;
      pointer-events: none;
    }
    /* AC-style cyan tooltip (matches the "Stone path" in-game label). */
    .build-path-tooltip {
      position: absolute;
      bottom: calc(100% + 10px);
      left: 50%;
      transform: translateX(-50%) translateY(4px) scale(0.82);
      background: #5fc5d4;
      color: #fff;
      padding: 5px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.3px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      box-shadow:
        0 4px 10px rgba(0, 0, 0, 0.18),
        inset 0 2px 0 rgba(255, 255, 255, 0.45),
        inset 0 -2px 0 rgba(20, 90, 110, 0.15);
      transition: opacity 0.16s ease,
                  transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .build-path-tooltip::after {
      content: '';
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 6px solid transparent;
      border-top-color: #5fc5d4;
    }
    .build-path-swatch:hover .build-path-tooltip,
    .build-path-swatch:focus-visible .build-path-tooltip {
      opacity: 1;
      transform: translateX(-50%) translateY(0) scale(1);
    }
    /* Subtle continuous bob while a swatch is hovered — sells the "alive"
       AC feel without distracting when the modal sits idle. */
    @keyframes build-path-bob {
      0%, 100% { transform: translateY(-3px) scale(1.06); }
      50%      { transform: translateY(-5px) scale(1.07); }
    }
    .build-path-swatch:hover {
      animation: build-path-bob 1.4s ease-in-out infinite;
    }
    .build-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    /* AC:NH-style round icon button + label below ----------------------- */
    .build-item-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      width: 64px;
    }
    .build-item-circle {
      width: 56px;
      height: 56px;
      padding: 0;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font-family: inherit;
      color: inherit;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow:
        0 3px 0 rgba(0, 0, 0, 0.10),
        inset 0 -3px 0 rgba(0, 0, 0, 0.08),
        inset 0 2px 0 rgba(255, 255, 255, 0.45);
      transition: transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1),
                  box-shadow 0.16s ease;
    }
    .build-item-circle:hover:not(:disabled) {
      transform: translateY(-2px) scale(1.08);
      box-shadow:
        0 7px 12px rgba(74, 56, 40, 0.22),
        inset 0 -3px 0 rgba(0, 0, 0, 0.08),
        inset 0 2px 0 rgba(255, 255, 255, 0.55);
    }
    .build-item-circle:active:not(:disabled) {
      transform: translateY(0) scale(1.02);
    }
    .build-item-circle-disabled,
    .build-item-circle:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .build-item-circle svg { width: 36px; height: 36px; pointer-events: none; }

    /* Per-tool background colors — pastels matching the AC:NH app palette */
    .build-item-circle-cliff_raise { background: #87cea0; }  /* leafy green   */
    .build-item-circle-cliff_lower { background: #e3a866; }  /* warm earth    */
    .build-item-circle-water_dig   { background: #7ab9d4; }  /* lake blue     */
    .build-item-circle-water_fill  { background: #b3dde6; }  /* shallow blue  */

    .build-item-label {
      font-size: 11px;
      font-weight: 600;
      color: #4a3828;
      line-height: 1.15;
      text-align: center;
    }
    .build-item-stock {
      font-size: 12px;
      color: #8c7060;
      font-variant-numeric: tabular-nums;
    }

    /* Bottom status bar (placement mode) */
    .build-status-bar {
      position: fixed;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%);
      display: none;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      background: rgba(255, 248, 240, 0.97);
      border: 2px solid #c4956a;
      border-radius: 14px;
      box-shadow: 0 6px 18px rgba(74, 56, 40, 0.28);
      pointer-events: auto;
      z-index: 55;
    }
    .build-status-bar.build-status-visible { display: flex; }
    .build-status-label {
      font-size: 14px;
      font-weight: 600;
      color: #4a3828;
      white-space: nowrap;
    }
    .build-status-hint {
      font-size: 12px;
      font-weight: 500;
      color: #8a755a;
      white-space: nowrap;
      opacity: 0.8;
    }

    /* Generic buttons */
    .build-btn {
      background: #f5ead8;
      color: #4a3828;
      border: 2px solid #c4956a;
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.12s ease, transform 0.05s ease;
    }
    .build-btn:hover { background: #e8d5a8; }
    .build-btn:active { transform: translateY(1px); }
    .build-btn-ghost {
      background: transparent;
      border-color: #b8956a;
    }
    .build-btn-ghost:hover { background: #f5ead8; }
    .build-btn-cancel {
      background: #ffe0d8;
      border-color: #e87860;
      color: #8c4030;
    }
    .build-btn-cancel:hover { background: #ffc8b8; }
  `;
  document.head.appendChild(style);
}
