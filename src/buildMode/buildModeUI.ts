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
  for (const item of buildMode.listItems()) {
    grid.appendChild(
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
}

function createItemCard(item: BuildItemInfo, onClick: () => void): HTMLElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'build-item-card';
  // Tools with `showStock !== false` are stock-limited (legacy props); tools
  // with showStock === false are unlimited (terraforming) and never disabled
  // by stock.
  const stockGated = item.showStock !== false;
  if (stockGated && item.stock <= 0) card.classList.add('build-item-card-disabled');
  card.disabled = stockGated && item.stock <= 0;

  const visual = document.createElement('div');
  visual.className = `build-item-visual build-item-visual-${item.kind}`;
  visual.innerHTML = renderItemVisual(item.kind);
  card.appendChild(visual);

  const label = document.createElement('div');
  label.className = 'build-item-label';
  label.textContent = item.label;
  card.appendChild(label);

  if (stockGated) {
    const stock = document.createElement('div');
    stock.className = 'build-item-stock';
    stock.textContent = `× ${item.stock}`;
    card.appendChild(stock);
  }

  card.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });

  return card;
}

function renderItemVisual(_kind: BuildKind): string {
  // Generic placeholder — Step 5 registers terraforming tools (cliff_raise,
  // water_dig, etc.) and provides per-tool icons. Until then no item is ever
  // listed (`BuildMode.listItems()` returns []) so this fallback is never
  // actually reached, but keeping a neutral icon avoids a tree/rock visual
  // accidentally showing if a future tool is registered without an icon.
  return `
    <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
      <rect x="10" y="10" width="28" height="28" rx="6" fill="#d4a878"/>
      <rect x="16" y="16" width="16" height="16" rx="3" fill="#fff8f0"/>
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

    /* Modal backdrop + panel */
    .build-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(74, 56, 40, 0.32);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 60;
      pointer-events: auto;
      backdrop-filter: blur(2px);
    }
    .build-modal-backdrop.build-modal-open { display: flex; }

    .build-modal-panel {
      width: min(440px, calc(100vw - 32px));
      max-height: calc(100vh - 60px);
      overflow-y: auto;
      background: #fff8f0;
      border: 3px solid #c4956a;
      border-radius: 18px;
      padding: 18px 22px 16px;
      box-shadow: 0 12px 32px rgba(74, 56, 40, 0.4);
    }
    .build-modal-header {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.3px;
      color: #4a3828;
      margin-bottom: 4px;
    }
    .build-modal-subtitle {
      font-size: 13px;
      color: #8c7060;
      margin-bottom: 14px;
    }
    .build-modal-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-bottom: 12px;
    }
    .build-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    /* Item card */
    .build-item-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 14px 10px 10px;
      background: #f5ead8;
      border: 2px solid #c4956a;
      border-radius: 14px;
      cursor: pointer;
      font-family: inherit;
      color: inherit;
      transition: transform 0.08s ease, background 0.12s ease, box-shadow 0.12s ease;
    }
    .build-item-card:hover:not(:disabled) {
      background: #ffe8a0;
      box-shadow: 0 4px 10px rgba(74, 56, 40, 0.18);
    }
    .build-item-card:active:not(:disabled) {
      transform: translateY(1px);
    }
    .build-item-card-disabled,
    .build-item-card:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .build-item-visual {
      width: 56px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fff8f0;
      border: 2px solid #d4a878;
      border-radius: 12px;
      margin-bottom: 4px;
    }
    .build-item-label {
      font-size: 13px;
      font-weight: 600;
      color: #4a3828;
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
