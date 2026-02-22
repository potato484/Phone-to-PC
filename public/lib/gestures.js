import { DOM } from './state.js';
import {
  computeVerticalFallbackLineDelta,
  computeHorizontalScrollUpdate,
  resolveDirectionLock
} from './gesture-scroll-policy.js';
import {
  computePinchScale,
  shouldApplyPinchScale
} from './gesture-mode-policy.js';

const DIRECTION_LOCK_THRESHOLD_PX = 8;
const LONG_PRESS_MS = 420;
const LONG_PRESS_MOVE_CANCEL_PX = 12;
const HORIZONTAL_INTENT_RATIO = 1.35;
const VERTICAL_RECOVER_RATIO = 1.15;
const TWO_FINGER_SCROLL_LOCK_THRESHOLD_PX = 6;
const TWO_FINGER_PINCH_LOCK_THRESHOLD_PX = 8;
const TWO_FINGER_PINCH_DOMINANCE_RATIO = 1.15;
const TWO_FINGER_PINCH_SCALE_EPSILON = 0.015;
const TWO_FINGER_PINCH_UPDATE_MIN_INTERVAL_MS = 24;
const TWO_FINGER_PARALLEL_MOVE_THRESHOLD_PX = 2;
const TWO_FINGER_SCROLL_LINE_PX = 14;
const SINGLE_FINGER_SCROLL_MOVE_EPSILON_PX = 0;
const SINGLE_FINGER_SCROLL_LINE_PX = 6;
const SINGLE_FINGER_SCROLL_LINE_PX_NO_VIEWPORT = 0.35;
const SINGLE_FINGER_FORCE_LINE_DY_NO_VIEWPORT = 0.08;
const SINGLE_FINGER_FALLBACK_MAX_LINES_PER_MOVE = 4;
const VIEWPORT_SCROLL_WRITE_EPSILON_PX = 0;
const TOUCH_SELECTION_AUTO_SCROLL_EDGE_PX = 28;
const TOUCH_SELECTION_AUTO_SCROLL_INTERVAL_MS = 60;
const GESTURE_DEBUG_STORAGE_KEY = 'c2p_debug_gestures';
const GESTURE_DEBUG_QUERY_KEY = 'debugGestures';

function readTouchCenter(touchA, touchB) {
  return {
    x: (touchA.clientX + touchB.clientX) / 2,
    y: (touchA.clientY + touchB.clientY) / 2
  };
}

function touchDistance(touchA, touchB) {
  const dx = touchA.clientX - touchB.clientX;
  const dy = touchA.clientY - touchB.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function clampMenuPosition(x, y, menuWidth, menuHeight) {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - menuWidth - margin);
  const maxY = Math.max(margin, window.innerHeight - menuHeight - margin);
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY)
  };
}

function scrollViewportByDeltaY(viewportEl, dy) {
  if (!(viewportEl instanceof HTMLElement)) {
    return false;
  }
  const safeDy = Number(dy);
  if (!Number.isFinite(safeDy)) {
    return false;
  }
  const maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight);
  if (maxScrollTop <= 0) {
    return false;
  }
  const nextScrollTop = Math.max(0, Math.min(maxScrollTop, viewportEl.scrollTop - safeDy));
  if (Math.abs(nextScrollTop - viewportEl.scrollTop) <= VIEWPORT_SCROLL_WRITE_EPSILON_PX) {
    return false;
  }
  viewportEl.scrollTop = nextScrollTop;
  return true;
}

function isGestureDebugEnabled() {
  if (typeof window === 'undefined') {
    return false;
  }
  if (window.__C2P_GESTURE_DEBUG__ === true) {
    return true;
  }
  try {
    const params = new URLSearchParams(window.location.search || '');
    const queryValue = (params.get(GESTURE_DEBUG_QUERY_KEY) || '').trim().toLowerCase();
    if (queryValue === '1' || queryValue === 'true' || queryValue === 'on') {
      return true;
    }
  } catch {
    // Ignore malformed URLs.
  }
  try {
    const stored = (window.localStorage.getItem(GESTURE_DEBUG_STORAGE_KEY) || '').trim().toLowerCase();
    return stored === '1' || stored === 'true' || stored === 'on';
  } catch {
    return false;
  }
}

export function createGestures({ getTerm, toast }) {
  let menuEl = null;
  let selectionHandleEls = null;
  let longPressTimer = 0;
  let longPressPoint = null;
  let suppressTouchEnd = false;
  let swipeStart = null;
  let directionLock = '';
  let twoFingerState = null;
  let touchSelectionState = null;
  let singleFingerScrollState = null;
  let singleFingerFallbackUsed = false;
  let singleFingerRejectReason = '';
  let lastSingleFingerNoConsumeDebugAt = 0;

  function debugGesture(stage, payload = null) {
    if (!isGestureDebugEnabled()) {
      return;
    }
    if (payload === null) {
      console.debug('[c2p:gestures]', stage);
      return;
    }
    console.debug('[c2p:gestures]', stage, payload);
  }

  function compareCells(a, b) {
    if (!a || !b) {
      return 0;
    }
    if (a.row === b.row) {
      return a.col - b.col;
    }
    return a.row - b.row;
  }

  function normalizeSelectionCells(anchorCell, focusCell) {
    if (!anchorCell || !focusCell) {
      return null;
    }
    if (compareCells(anchorCell, focusCell) <= 0) {
      return {
        start: anchorCell,
        end: focusCell
      };
    }
    return {
      start: focusCell,
      end: anchorCell
    };
  }

  function resolveSelectionHandleKindFromTarget(target) {
    if (!(target instanceof Element)) {
      return '';
    }
    const handle = target.closest('.touch-selection-handle[data-handle]');
    if (!(handle instanceof HTMLElement)) {
      return '';
    }
    const kind = handle.dataset.handle || '';
    if (kind === 'start' || kind === 'end') {
      return kind;
    }
    return '';
  }

  function ensureSelectionHandles() {
    if (selectionHandleEls) {
      return selectionHandleEls;
    }
    const root = DOM.terminalWrap || document.body;
    const startEl = document.createElement('div');
    startEl.className = 'touch-selection-handle';
    startEl.dataset.handle = 'start';
    startEl.hidden = true;
    const endEl = document.createElement('div');
    endEl.className = 'touch-selection-handle';
    endEl.dataset.handle = 'end';
    endEl.hidden = true;
    root.appendChild(startEl);
    root.appendChild(endEl);
    selectionHandleEls = {
      startEl,
      endEl
    };
    return selectionHandleEls;
  }

  function hideSelectionHandles() {
    if (!selectionHandleEls) {
      return;
    }
    selectionHandleEls.startEl.hidden = true;
    selectionHandleEls.endEl.hidden = true;
  }

  function placeSelectionHandle(handleEl, point) {
    if (!(handleEl instanceof HTMLElement) || !point) {
      return;
    }
    handleEl.hidden = false;
    handleEl.style.left = `${Math.round(point.x)}px`;
    handleEl.style.top = `${Math.round(point.y)}px`;
  }

  function ensureMenu() {
    if (menuEl) {
      return menuEl;
    }
    menuEl = document.createElement('div');
    menuEl.className = 'touch-context-menu';
    menuEl.hidden = true;
    menuEl.innerHTML = `
      <button type="button" class="touch-context-btn" data-action="copy">复制</button>
      <button type="button" class="touch-context-btn" data-action="paste">粘贴</button>
    `;
    document.body.appendChild(menuEl);

    const resolveActionButton = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const node of path) {
        if (!(node instanceof Element)) {
          continue;
        }
        const buttonFromPath = node.closest('[data-action]');
        if (buttonFromPath && menuEl && menuEl.contains(buttonFromPath)) {
          return buttonFromPath;
        }
      }
      const target = event.target;
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      if (!element) {
        return;
      }
      const button = element.closest('[data-action]');
      if (!button || (menuEl && !menuEl.contains(button))) {
        return;
      }
      return button;
    };

    menuEl.addEventListener('click', async (event) => {
      const button = resolveActionButton(event);
      if (!button) {
        return;
      }
      const action = button.dataset.action;
      if (action === 'copy') {
        const term = getTerm();
        if (!term || typeof term.getActiveSelectionText !== 'function') {
          hideMenu();
          return;
        }
        const text = term.getActiveSelectionText();
        if (!text) {
          toast.show('未选中文本', 'warn');
          hideMenu();
          return;
        }
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          toast.show('当前环境不支持复制', 'warn');
          hideMenu();
          return;
        }
        try {
          await navigator.clipboard.writeText(text);
          if (typeof term.clearActiveSelection === 'function') {
            term.clearActiveSelection();
          }
          endTouchSelection();
          toast.show('已复制到剪贴板', 'success');
        } catch {
          toast.show('复制失败', 'danger');
        }
        hideMenu();
        return;
      }

      if (action === 'paste') {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
          toast.show('当前环境不支持粘贴', 'warn');
          hideMenu();
          return;
        }
        const term = getTerm();
        if (!term) {
          hideMenu();
          return;
        }
        try {
          const text = await navigator.clipboard.readText();
          if (!text) {
            toast.show('剪贴板为空', 'warn');
            hideMenu();
            return;
          }
          const sent = term.sendData(text);
          if (!sent) {
            toast.show('终端未连接', 'warn');
          }
        } catch {
          toast.show('粘贴失败', 'danger');
        }
        hideMenu();
        return;
      }

    });

    const dismissOnOutsidePress = (event) => {
      if (!menuEl || menuEl.hidden) {
        return;
      }
      if (menuEl.contains(event.target)) {
        return;
      }
      hideMenu();
    };

    document.addEventListener('pointerdown', dismissOnOutsidePress, { passive: true, capture: true });
    document.addEventListener('click', dismissOnOutsidePress, { passive: true, capture: true });

    return menuEl;
  }

  function hideMenu() {
    if (!menuEl) {
      return;
    }
    menuEl.hidden = true;
  }

  function showMenu(x, y) {
    const menu = ensureMenu();
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const { width, height } = menu.getBoundingClientRect();
    const next = clampMenuPosition(x, y, width || 168, height || 92);
    menu.style.left = `${Math.round(next.x)}px`;
    menu.style.top = `${Math.round(next.y)}px`;
  }

  function clearLongPress() {
    if (longPressTimer) {
      window.clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
    longPressPoint = null;
  }

  function resetSwipeTracking() {
    swipeStart = null;
    directionLock = '';
  }

  function resetGestureState() {
    clearLongPress();
    suppressTouchEnd = false;
    resetSwipeTracking();
    twoFingerState = null;
    singleFingerScrollState = null;
    endTouchSelection({
      clearTerminalSelection: true
    });
    hideMenu();
  }

  function pointFromTouch(touch) {
    if (!touch) {
      return null;
    }
    return {
      x: Number(touch.clientX) || 0,
      y: Number(touch.clientY) || 0
    };
  }

  function hasActiveTerminalSelection() {
    const term = getTerm();
    if (!term || typeof term.getActiveSelectionText !== 'function') {
      return false;
    }
    return !!term.getActiveSelectionText();
  }

  function showClipboardMenuAtPoint(point) {
    if (!point) {
      return;
    }
    showMenu(point.x, point.y);
  }

  function beginTerminalSelectionOrOpenClipboardMenu(point) {
    if (!point) {
      return;
    }
    if (hasActiveTerminalSelection()) {
      suppressTouchEnd = true;
      showClipboardMenuAtPoint(point);
      return;
    }
    const startedSelection = beginTouchSelection(point);
    if (!startedSelection) {
      suppressTouchEnd = true;
      showClipboardMenuAtPoint(point);
    }
  }

  function updateTouchSelectionHandles() {
    if (!touchSelectionState) {
      hideSelectionHandles();
      return;
    }
    const range = normalizeSelectionCells(touchSelectionState.anchorCell, touchSelectionState.focusCell);
    if (!range) {
      hideSelectionHandles();
      return;
    }
    const term = getTerm();
    if (!term || typeof term.resolveActiveClientPointFromCell !== 'function') {
      hideSelectionHandles();
      return;
    }
    const startPoint = term.resolveActiveClientPointFromCell(range.start, {
      edge: 'start'
    });
    const endPoint = term.resolveActiveClientPointFromCell(range.end, {
      edge: 'end'
    });
    if (!startPoint || !endPoint) {
      hideSelectionHandles();
      return;
    }
    const handles = ensureSelectionHandles();
    placeSelectionHandle(handles.startEl, startPoint);
    placeSelectionHandle(handles.endEl, endPoint);
  }

  function stopTouchSelectionAutoScroll() {
    if (!touchSelectionState) {
      return;
    }
    if (touchSelectionState.autoScrollTimer) {
      window.clearInterval(touchSelectionState.autoScrollTimer);
      touchSelectionState.autoScrollTimer = 0;
    }
    touchSelectionState.autoScrollDir = 0;
  }

  function applyTouchSelection(anchorCell, focusCell, point = null) {
    if (!touchSelectionState || !anchorCell || !focusCell) {
      return false;
    }
    const term = getTerm();
    if (!term || typeof term.selectActiveRange !== 'function') {
      return false;
    }
    if (!term.selectActiveRange(anchorCell, focusCell)) {
      return false;
    }
    touchSelectionState.anchorCell = anchorCell;
    touchSelectionState.focusCell = focusCell;
    if (point) {
      touchSelectionState.lastPoint = point;
    }
    updateTouchSelectionHandles();
    return true;
  }

  function beginTouchSelection(point) {
    if (!point) {
      return false;
    }
    const term = getTerm();
    if (
      !term ||
      typeof term.resolveActiveCellFromClientPoint !== 'function' ||
      typeof term.selectActiveRange !== 'function'
    ) {
      return false;
    }
    const anchorCell = term.resolveActiveCellFromClientPoint(point.x, point.y);
    if (!anchorCell) {
      return false;
    }
    if (!term.selectActiveRange(anchorCell, anchorCell)) {
      return false;
    }
    touchSelectionState = {
      anchorCell,
      focusCell: anchorCell,
      lastPoint: point,
      autoScrollDir: 0,
      autoScrollTimer: 0,
      dragHandle: ''
    };
    updateTouchSelectionHandles();
    return true;
  }

  function updateTouchSelection(point) {
    if (!touchSelectionState || !point) {
      return false;
    }
    const term = getTerm();
    if (!term || typeof term.resolveActiveCellFromClientPoint !== 'function') {
      return false;
    }
    const focusCell = term.resolveActiveCellFromClientPoint(point.x, point.y);
    if (!focusCell) {
      return false;
    }
    return applyTouchSelection(touchSelectionState.anchorCell, focusCell, point);
  }

  function updateTouchSelectionFromHandle(point, handleKind) {
    if (!touchSelectionState || !point) {
      return false;
    }
    const safeHandleKind = handleKind === 'start' || handleKind === 'end' ? handleKind : '';
    if (!safeHandleKind) {
      return false;
    }
    const term = getTerm();
    if (!term || typeof term.resolveActiveCellFromClientPoint !== 'function') {
      return false;
    }
    const handleCell = term.resolveActiveCellFromClientPoint(point.x, point.y);
    if (!handleCell) {
      return false;
    }
    const nextAnchorCell = safeHandleKind === 'start' ? handleCell : touchSelectionState.anchorCell;
    const nextFocusCell = safeHandleKind === 'end' ? handleCell : touchSelectionState.focusCell;
    return applyTouchSelection(nextAnchorCell, nextFocusCell, point);
  }

  function setTouchSelectionAutoScrollDirection(nextDirection) {
    if (!touchSelectionState) {
      return;
    }
    const safeDirection = Number.isFinite(nextDirection) ? Math.max(-1, Math.min(1, Math.trunc(nextDirection))) : 0;
    if (safeDirection === touchSelectionState.autoScrollDir) {
      return;
    }
    stopTouchSelectionAutoScroll();
    if (!safeDirection) {
      return;
    }
    touchSelectionState.autoScrollDir = safeDirection;
    touchSelectionState.autoScrollTimer = window.setInterval(() => {
      if (!touchSelectionState) {
        return;
      }
      const term = getTerm();
      if (!term || typeof term.scrollActivePaneByLines !== 'function') {
        return;
      }
      if (term.scrollActivePaneByLines(safeDirection)) {
        const handleKind = touchSelectionState.dragHandle || '';
        if (handleKind) {
          updateTouchSelectionFromHandle(touchSelectionState.lastPoint, handleKind);
          return;
        }
        updateTouchSelection(touchSelectionState.lastPoint);
      }
    }, TOUCH_SELECTION_AUTO_SCROLL_INTERVAL_MS);
  }

  function completeTouchSelectionGesture(point = null) {
    if (!touchSelectionState) {
      return false;
    }
    stopTouchSelectionAutoScroll();
    const endPoint = point || touchSelectionState.lastPoint;
    const handleKind = touchSelectionState.dragHandle || '';
    if (endPoint) {
      if (handleKind) {
        updateTouchSelectionFromHandle(endPoint, handleKind);
      } else {
        updateTouchSelection(endPoint);
      }
    }
    touchSelectionState.dragHandle = '';
    updateTouchSelectionHandles();
    return true;
  }

  function endTouchSelection(options = {}) {
    if (!touchSelectionState) {
      return false;
    }
    const clearTerminalSelection = !!(options && options.clearTerminalSelection);
    stopTouchSelectionAutoScroll();
    touchSelectionState = null;
    hideSelectionHandles();
    if (clearTerminalSelection) {
      const term = getTerm();
      if (term && typeof term.clearActiveSelection === 'function') {
        term.clearActiveSelection();
      }
    }
    return true;
  }

  function beginSingleFingerScrollStateFromResolvedTargets(
    touch,
    viewportEl,
    horizontalScrollTarget = null,
    blockNativeScroll = true
  ) {
    if (!(touch && Number.isFinite(touch.clientX) && Number.isFinite(touch.clientY))) {
      singleFingerRejectReason = 'invalid-touch-coordinates';
      return false;
    }
    if (!(viewportEl instanceof HTMLElement)) {
      singleFingerRejectReason = 'missing-viewport';
      return false;
    }
    singleFingerScrollState = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastY: touch.clientY,
      horizontalScrollTarget,
      horizontalScrollLeft: horizontalScrollTarget ? horizontalScrollTarget.scrollLeft : 0,
      viewportEl,
      pendingScrollPx: 0,
      blockNativeScroll: !!blockNativeScroll
    };
    singleFingerRejectReason = '';
    return true;
  }

  function beginSingleFingerScrollMode(touch, target) {
    singleFingerRejectReason = '';
    singleFingerFallbackUsed = false;
    const term = getTerm();
    if (!term) {
      singleFingerRejectReason = 'term-unavailable';
      return false;
    }
    if (!(target instanceof Element)) {
      singleFingerRejectReason = 'target-not-element';
      return false;
    }
    if (target.closest('.terminal-pane-actions')) {
      singleFingerRejectReason = 'target-in-pane-actions';
      return false;
    }
    const paneBodyEl = target.closest('.terminal-pane-body');
    const paneEl = paneBodyEl instanceof HTMLElement ? paneBodyEl.closest('.terminal-pane') : target.closest('.terminal-pane');
    const viewportEl =
      resolveTerminalViewport(target) ||
      (typeof term.getActivePaneViewportElement === 'function' ? term.getActivePaneViewportElement() : null);
    let horizontalScrollTarget = resolveHorizontalScrollTarget(target);
    if (!horizontalScrollTarget && paneBodyEl instanceof HTMLElement) {
      horizontalScrollTarget = paneBodyEl.scrollWidth > paneBodyEl.clientWidth + 1 ? paneBodyEl : null;
    }
    if (
      paneBodyEl instanceof HTMLElement &&
      beginSingleFingerScrollStateFromResolvedTargets(touch, viewportEl, horizontalScrollTarget, true)
    ) {
      debugGesture('single-finger-start', {
        fallback: false,
        paneId: paneEl && paneEl.dataset ? paneEl.dataset.paneId || '' : '',
        hasHorizontalTarget: !!horizontalScrollTarget
      });
      return true;
    }

    const activeViewport =
      typeof term.getActivePaneViewportElement === 'function' ? term.getActivePaneViewportElement() : null;
    if (!(activeViewport instanceof HTMLElement)) {
      singleFingerRejectReason = 'fallback-active-viewport-missing';
      return false;
    }
    const activePane = activeViewport.closest('.terminal-pane');
    const activePaneBody = activePane instanceof HTMLElement ? activePane.querySelector('.terminal-pane-body') : null;
    const fallbackHorizontalTarget =
      activePaneBody instanceof HTMLElement && activePaneBody.scrollWidth > activePaneBody.clientWidth + 1
        ? activePaneBody
        : null;
    if (!beginSingleFingerScrollStateFromResolvedTargets(touch, activeViewport, fallbackHorizontalTarget, true)) {
      return false;
    }
    singleFingerFallbackUsed = true;
    debugGesture('single-finger-start-fallback', {
      reason: paneBodyEl instanceof HTMLElement ? 'direct-start-failed' : 'missing-pane-body',
      targetTag: target.tagName || '',
      targetClass: target.className || ''
    });
    return true;
  }

  function beginSingleFingerScrollGesture(touch) {
    resetSwipeTracking();
    clearLongPress();
    longPressPoint = {
      x: touch.clientX,
      y: touch.clientY
    };
    longPressTimer = window.setTimeout(() => {
      longPressTimer = 0;
      if (!longPressPoint) {
        return;
      }
      endSingleFingerScrollMode();
      beginTerminalSelectionOrOpenClipboardMenu(longPressPoint);
    }, LONG_PRESS_MS);
  }

  function updateSingleFingerScrollMode(touch) {
    if (!singleFingerScrollState) {
      return false;
    }
    const term = getTerm();
    const currentX = Number(touch && touch.clientX);
    const currentY = Number(touch && touch.clientY);
    if (!Number.isFinite(currentX) || !Number.isFinite(currentY)) {
      return false;
    }
    const totalDx = currentX - singleFingerScrollState.startX;
    const totalDy = currentY - singleFingerScrollState.startY;
    const absDx = Math.abs(totalDx);
    const absDy = Math.abs(totalDy);
    const preferHorizontal = absDx >= Math.max(6, absDy * HORIZONTAL_INTENT_RATIO);
    let consumedHorizontal = false;
    if (singleFingerScrollState.horizontalScrollTarget && preferHorizontal) {
      const horizontalScrollUpdate = computeHorizontalScrollUpdate(
        singleFingerScrollState.horizontalScrollTarget,
        singleFingerScrollState.horizontalScrollLeft,
        totalDx
      );
      if (horizontalScrollUpdate.shouldConsume) {
        singleFingerScrollState.horizontalScrollTarget.scrollLeft = horizontalScrollUpdate.nextScrollLeft;
        consumedHorizontal = true;
      }
    }

    const dy = currentY - singleFingerScrollState.lastY;
    singleFingerScrollState.lastY = currentY;
    let consumedVertical = false;
    if (!consumedHorizontal && Math.abs(dy) <= Number.EPSILON) {
      return false;
    }

    const viewportEl =
      singleFingerScrollState.viewportEl instanceof HTMLElement && document.contains(singleFingerScrollState.viewportEl)
        ? singleFingerScrollState.viewportEl
        : term && typeof term.getActivePaneViewportElement === 'function'
          ? term.getActivePaneViewportElement()
          : null;
    if (viewportEl instanceof HTMLElement) {
      singleFingerScrollState.viewportEl = viewportEl;
    }
    const viewportMaxScrollTop =
      viewportEl instanceof HTMLElement ? Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight) : 0;

    if (scrollViewportByDeltaY(singleFingerScrollState.viewportEl, dy)) {
      consumedVertical = true;
      singleFingerScrollState.pendingScrollPx = 0;
      return consumedHorizontal || consumedVertical;
    }

    const fallbackLineUpdate = computeVerticalFallbackLineDelta({
      pendingScrollPx: singleFingerScrollState.pendingScrollPx,
      dy,
      lineStepPx:
        viewportMaxScrollTop > 0 ? SINGLE_FINGER_SCROLL_LINE_PX : SINGLE_FINGER_SCROLL_LINE_PX_NO_VIEWPORT,
      maxLinesPerMove: SINGLE_FINGER_FALLBACK_MAX_LINES_PER_MOVE
    });
    singleFingerScrollState.pendingScrollPx = fallbackLineUpdate.nextPendingScrollPx;
    let lineDelta = fallbackLineUpdate.lineDelta;
    let requestedLineDelta = fallbackLineUpdate.requestedLineDelta;
    if (!lineDelta && viewportMaxScrollTop <= 0 && Math.abs(dy) >= SINGLE_FINGER_FORCE_LINE_DY_NO_VIEWPORT) {
      lineDelta = dy < 0 ? 1 : -1;
      requestedLineDelta = lineDelta;
      singleFingerScrollState.pendingScrollPx = 0;
    }
    if (!lineDelta) {
      if (Math.abs(dy) >= 1 && isGestureDebugEnabled()) {
        const now = Date.now();
        if (now - lastSingleFingerNoConsumeDebugAt > 200) {
          lastSingleFingerNoConsumeDebugAt = now;
          debugGesture('single-finger-fallback-wait-threshold', {
            dy,
            pendingScrollPx: singleFingerScrollState.pendingScrollPx,
            requestedLineDelta,
            fallbackUsed: singleFingerFallbackUsed
          });
        }
      }
      return consumedHorizontal;
    }

    if (!term) {
      if (Math.abs(dy) >= 1 && isGestureDebugEnabled()) {
        const now = Date.now();
        if (now - lastSingleFingerNoConsumeDebugAt > 200) {
          lastSingleFingerNoConsumeDebugAt = now;
          debugGesture('single-finger-fallback-term-missing', {
            dy,
            lineDelta,
            requestedLineDelta,
            pendingScrollPx: singleFingerScrollState.pendingScrollPx,
            fallbackUsed: singleFingerFallbackUsed
          });
        }
      }
      return consumedHorizontal;
    }

    const tryScrollByLines = (deltaLines) => {
      const safeDeltaLines = Number.isFinite(deltaLines) ? Math.trunc(deltaLines) : 0;
      if (!safeDeltaLines) {
        return false;
      }
      if (
        typeof term.scrollPaneByViewportElement === 'function' &&
        singleFingerScrollState.viewportEl instanceof HTMLElement &&
        term.scrollPaneByViewportElement(singleFingerScrollState.viewportEl, safeDeltaLines)
      ) {
        return true;
      }
      if (typeof term.scrollActivePaneByLines === 'function') {
        return term.scrollActivePaneByLines(safeDeltaLines);
      }
      return false;
    };
    if (tryScrollByLines(lineDelta)) {
      consumedVertical = true;
      singleFingerScrollState.pendingScrollPx = 0;
      return consumedHorizontal || consumedVertical;
    }
    if (typeof term.scrollActivePaneByLines === 'function') {
      consumedVertical = false;
      if (!consumedVertical && !consumedHorizontal && Math.abs(dy) >= 1 && isGestureDebugEnabled()) {
        const now = Date.now();
        if (now - lastSingleFingerNoConsumeDebugAt > 200) {
          lastSingleFingerNoConsumeDebugAt = now;
          const viewportForDebug =
            singleFingerScrollState.viewportEl instanceof HTMLElement ? singleFingerScrollState.viewportEl : null;
          const viewportMaxScrollTop = viewportForDebug
            ? Math.max(0, viewportForDebug.scrollHeight - viewportForDebug.clientHeight)
            : 0;
          debugGesture('single-finger-move-not-consumed', {
            dy,
            lineDelta,
            requestedLineDelta,
            pendingScrollPx: singleFingerScrollState.pendingScrollPx,
            viewportScrollTop: viewportForDebug ? viewportForDebug.scrollTop : null,
            viewportMaxScrollTop,
            fallbackUsed: singleFingerFallbackUsed
          });
        }
      }
      return consumedHorizontal || consumedVertical;
    }
    if (!consumedHorizontal && Math.abs(dy) >= 1) {
      debugGesture('single-finger-move-no-scroll-api', {
        dy,
        lineDelta,
        requestedLineDelta,
        fallbackUsed: singleFingerFallbackUsed
      });
    }
    return consumedHorizontal || consumedVertical;
  }

  function endSingleFingerScrollMode() {
    singleFingerScrollState = null;
    singleFingerFallbackUsed = false;
  }

  function activatePaneFromEventTarget(target) {
    if (!(target instanceof Element)) {
      return;
    }
    if (target.closest('.terminal-pane-actions')) {
      return;
    }
    const paneEl = target.closest('.terminal-pane');
    if (paneEl instanceof HTMLElement) {
      const paneId = paneEl.dataset.paneId || '';
      const term = getTerm();
      if (paneId && term && typeof term.setActivePaneById === 'function') {
        term.setActivePaneById(paneId, { focus: false });
        return;
      }
      paneEl.click();
    }
  }

  function isTerminalInteractiveTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    return !!target.closest('.terminal-pane-body, .terminal-pane-terminal, .xterm');
  }

  function resolveHorizontalScrollTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    const container = target.closest('.terminal-pane-body');
    if (!container) {
      return null;
    }
    return container.scrollWidth > container.clientWidth + 1 ? container : null;
  }

  function resolveTerminalViewport(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    const pane = target.closest('.terminal-pane');
    if (pane) {
      const viewportFromPane = pane.querySelector('.xterm-viewport');
      if (viewportFromPane instanceof HTMLElement) {
        return viewportFromPane;
      }
    }
    if (!DOM.terminalGrid) {
      return null;
    }
    const activeViewport = DOM.terminalGrid.querySelector('.terminal-pane.is-active .xterm-viewport');
    if (activeViewport instanceof HTMLElement) {
      return activeViewport;
    }
    return null;
  }

  function bind() {
    if (!DOM.terminalWrap) {
      return;
    }

    DOM.terminalWrap.addEventListener(
      'contextmenu',
      (event) => {
        if (isTerminalInteractiveTarget(event.target)) {
          event.preventDefault();
        }
      },
      { capture: true }
    );

    DOM.terminalWrap.addEventListener(
      'selectstart',
      (event) => {
        if (isTerminalInteractiveTarget(event.target)) {
          event.preventDefault();
        }
      },
      { capture: true }
    );

    DOM.terminalWrap.addEventListener(
      'touchstart',
      (event) => {
        hideMenu();
        const touches = event.touches;
        const startedInTerminal = isTerminalInteractiveTarget(event.target);
        const selectionHandleKind = resolveSelectionHandleKindFromTarget(event.target);
        if (touchSelectionState && selectionHandleKind && touches.length === 1) {
          clearLongPress();
          suppressTouchEnd = false;
          resetSwipeTracking();
          twoFingerState = null;
          endSingleFingerScrollMode();
          touchSelectionState.dragHandle = selectionHandleKind;
          const point = pointFromTouch(touches[0]);
          if (point) {
            touchSelectionState.lastPoint = point;
            updateTouchSelectionFromHandle(point, selectionHandleKind);
          }
          event.preventDefault();
          return;
        }
        if (touchSelectionState && !selectionHandleKind) {
          endTouchSelection({
            clearTerminalSelection: true
          });
        }
        activatePaneFromEventTarget(event.target);
        if (event.target instanceof Element && event.target.closest('.terminal-pane-actions')) {
          clearLongPress();
          resetSwipeTracking();
          twoFingerState = null;
          endSingleFingerScrollMode();
          endTouchSelection({
            clearTerminalSelection: true
          });
          return;
        }

        if (touches.length === 2) {
          clearLongPress();
          suppressTouchEnd = false;
          resetSwipeTracking();
          endSingleFingerScrollMode();
          endTouchSelection({
            clearTerminalSelection: true
          });
          if (!startedInTerminal) {
            twoFingerState = null;
            return;
          }
          const term = getTerm();
          const baseFontSize =
            term && typeof term.getFontSize === 'function' ? Number(term.getFontSize()) : Number.NaN;
          const center = readTouchCenter(touches[0], touches[1]);
          const distance = touchDistance(touches[0], touches[1]);
          twoFingerState = {
            mode: '',
            startCenterX: center.x,
            startCenterY: center.y,
            centerX: center.x,
            centerY: center.y,
            startDistance: distance,
            distance,
            pendingScrollPx: 0,
            viewportEl: resolveTerminalViewport(event.target),
            touchALastX: touches[0].clientX,
            touchALastY: touches[0].clientY,
            touchBLastX: touches[1].clientX,
            touchBLastY: touches[1].clientY,
            baseFontSize: Number.isFinite(baseFontSize) && baseFontSize > 0 ? baseFontSize : 0,
            lastAppliedScale: 1,
            lastAppliedAtMs: 0
          };
          return;
        }
        if (touches.length !== 1) {
          clearLongPress();
          resetSwipeTracking();
          twoFingerState = null;
          endSingleFingerScrollMode();
          endTouchSelection({
            clearTerminalSelection: true
          });
          return;
        }

        twoFingerState = null;
        const touch = touches[0];
        if (startedInTerminal && beginSingleFingerScrollMode(touch, event.target)) {
          beginSingleFingerScrollGesture(touch);
          return;
        }
        if (startedInTerminal) {
          debugGesture('single-finger-start-rejected', {
            reason: singleFingerRejectReason || 'unknown',
            targetTag: event.target instanceof Element ? event.target.tagName : '',
            targetClass:
              event.target instanceof Element
                ? typeof event.target.className === 'string'
                  ? event.target.className
                  : ''
                : ''
          });
        }
        endSingleFingerScrollMode();
        const horizontalScrollTarget = startedInTerminal ? null : resolveHorizontalScrollTarget(event.target);
        resetSwipeTracking();
        swipeStart = {
          x: touch.clientX,
          y: touch.clientY,
          startedInTerminal,
          horizontalScrollTarget,
          horizontalScrollLeft: horizontalScrollTarget ? horizontalScrollTarget.scrollLeft : 0
        };
        clearLongPress();
        longPressPoint = {
          x: touch.clientX,
          y: touch.clientY
        };
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0;
          if (!longPressPoint) {
            return;
          }
          if (startedInTerminal) {
            beginTerminalSelectionOrOpenClipboardMenu(longPressPoint);
            return;
          }
          suppressTouchEnd = true;
          showClipboardMenuAtPoint(longPressPoint);
        }, LONG_PRESS_MS);
      },
      { capture: true, passive: false }
    );

    DOM.terminalWrap.addEventListener(
      'touchmove',
      (event) => {
        const touches = event.touches;
        if (!singleFingerScrollState && !touchSelectionState && !twoFingerState && !swipeStart) {
          return;
        }
        if (singleFingerScrollState && touches.length === 1) {
          const lockNativeScroll = !!singleFingerScrollState.blockNativeScroll;
          clearLongPress();
          const consumed = updateSingleFingerScrollMode(touches[0]);
          if (consumed || lockNativeScroll) {
            event.preventDefault();
          }
          return;
        }

        if (touchSelectionState && touches.length === 1) {
          clearLongPress();
          const point = pointFromTouch(touches[0]);
          const handleKind = touchSelectionState.dragHandle || '';
          const updated = handleKind ? updateTouchSelectionFromHandle(point, handleKind) : updateTouchSelection(point);
          if (handleKind && point && !updated) {
            touchSelectionState.lastPoint = point;
          }
          if (updated || !!handleKind) {
            const term = getTerm();
            const viewportEl =
              term && typeof term.getActivePaneViewportElement === 'function'
                ? term.getActivePaneViewportElement()
                : null;
            let autoScrollDir = 0;
            if (viewportEl instanceof HTMLElement) {
              const rect = viewportEl.getBoundingClientRect();
              if (point && point.y <= rect.top + TOUCH_SELECTION_AUTO_SCROLL_EDGE_PX) {
                autoScrollDir = -1;
              } else if (point && point.y >= rect.bottom - TOUCH_SELECTION_AUTO_SCROLL_EDGE_PX) {
                autoScrollDir = 1;
              }
            }
            setTouchSelectionAutoScrollDirection(autoScrollDir);
            event.preventDefault();
            return;
          }
        }

        if (twoFingerState && touches.length === 2) {
          clearLongPress();
          const center = readTouchCenter(touches[0], touches[1]);
          const distance = touchDistance(touches[0], touches[1]);
          const moveADx = touches[0].clientX - twoFingerState.touchALastX;
          const moveADy = touches[0].clientY - twoFingerState.touchALastY;
          const moveBDx = touches[1].clientX - twoFingerState.touchBLastX;
          const moveBDy = touches[1].clientY - twoFingerState.touchBLastY;
          const sameDirectionDot = moveADx * moveBDx + moveADy * moveBDy;
          const parallelVerticalIntent =
            Math.sign(moveADy) !== 0 &&
            Math.sign(moveADy) === Math.sign(moveBDy) &&
            ((Math.abs(moveADy) + Math.abs(moveBDy)) / 2 >= TWO_FINGER_PARALLEL_MOVE_THRESHOLD_PX ||
              sameDirectionDot > 0);
          const centerDeltaFromStart = Math.hypot(
            center.x - twoFingerState.startCenterX,
            center.y - twoFingerState.startCenterY
          );
          const pinchDeltaFromStart = Math.abs(distance - twoFingerState.startDistance);
          if (!twoFingerState.mode) {
            const pinchIntent =
              pinchDeltaFromStart >= TWO_FINGER_PINCH_LOCK_THRESHOLD_PX &&
              pinchDeltaFromStart > centerDeltaFromStart * TWO_FINGER_PINCH_DOMINANCE_RATIO;
            const scrollIntent = centerDeltaFromStart >= TWO_FINGER_SCROLL_LOCK_THRESHOLD_PX;
            if (parallelVerticalIntent && scrollIntent) {
              twoFingerState.mode = 'scroll';
            } else if (pinchIntent) {
              twoFingerState.mode = 'pinch';
            } else if (scrollIntent) {
              twoFingerState.mode = 'scroll';
            }
          }

          if (twoFingerState.mode === 'pinch') {
            const term = getTerm();
            const scale = computePinchScale(twoFingerState.startDistance, distance);
            const nowMs = Date.now();
            const baseFontSize =
              Number.isFinite(twoFingerState.baseFontSize) && twoFingerState.baseFontSize > 0
                ? twoFingerState.baseFontSize
                : term && typeof term.getFontSize === 'function'
                  ? Number(term.getFontSize())
                  : 0;
            if (
              term &&
              typeof term.scaleFont === 'function' &&
              Number.isFinite(baseFontSize) &&
              baseFontSize > 0 &&
              shouldApplyPinchScale({
                scale,
                lastScale: twoFingerState.lastAppliedScale,
                nowMs,
                lastAppliedAtMs: twoFingerState.lastAppliedAtMs,
                scaleEpsilon: TWO_FINGER_PINCH_SCALE_EPSILON,
                minIntervalMs: TWO_FINGER_PINCH_UPDATE_MIN_INTERVAL_MS
              })
            ) {
              term.scaleFont(baseFontSize, scale);
              twoFingerState.baseFontSize = baseFontSize;
              twoFingerState.lastAppliedScale = scale;
              twoFingerState.lastAppliedAtMs = nowMs;
            }
            twoFingerState.centerX = center.x;
            twoFingerState.centerY = center.y;
            twoFingerState.distance = distance;
            event.preventDefault();
            return;
          }

          const dy = center.y - twoFingerState.centerY;
          if (twoFingerState.mode === 'scroll') {
            let consumed = false;
            const term = getTerm();
            const viewportEl =
              twoFingerState.viewportEl instanceof HTMLElement && document.contains(twoFingerState.viewportEl)
                ? twoFingerState.viewportEl
                : resolveTerminalViewport(event.target);
            if (viewportEl instanceof HTMLElement) {
              twoFingerState.viewportEl = viewportEl;
              consumed = scrollViewportByDeltaY(viewportEl, dy);
            }
            if (!consumed) {
              if (term && typeof term.scrollActivePaneByLines === 'function') {
                twoFingerState.pendingScrollPx -= dy;
                const rawLines = twoFingerState.pendingScrollPx / TWO_FINGER_SCROLL_LINE_PX;
                let lineDelta = 0;
                if (rawLines > 0) {
                  lineDelta = Math.floor(rawLines);
                } else if (rawLines < 0) {
                  lineDelta = Math.ceil(rawLines);
                }
                if (lineDelta !== 0 && term.scrollActivePaneByLines(lineDelta)) {
                  consumed = true;
                  twoFingerState.pendingScrollPx -= lineDelta * TWO_FINGER_SCROLL_LINE_PX;
                }
              }
            }
            if (consumed) {
              event.preventDefault();
            }
          }

          twoFingerState.centerX = center.x;
          twoFingerState.centerY = center.y;
          twoFingerState.distance = distance;
          twoFingerState.touchALastX = touches[0].clientX;
          twoFingerState.touchALastY = touches[0].clientY;
          twoFingerState.touchBLastX = touches[1].clientX;
          twoFingerState.touchBLastY = touches[1].clientY;
          return;
        }

        if (touches.length !== 1 || !swipeStart) {
          return;
        }
        const touch = touches[0];
        const dx = touch.clientX - swipeStart.x;
        const dy = touch.clientY - swipeStart.y;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (
          !longPressTimer &&
          !directionLock &&
          absDx < DIRECTION_LOCK_THRESHOLD_PX &&
          absDy < DIRECTION_LOCK_THRESHOLD_PX
        ) {
          return;
        }
        const horizontalScrollUpdate = swipeStart.horizontalScrollTarget
          ? computeHorizontalScrollUpdate(
              swipeStart.horizontalScrollTarget,
              swipeStart.horizontalScrollLeft,
              dx
            )
          : null;

        directionLock = resolveDirectionLock({
          currentLock: directionLock,
          absDx,
          absDy,
          thresholdPx: DIRECTION_LOCK_THRESHOLD_PX,
          hasHorizontalTarget: !!swipeStart.horizontalScrollTarget,
          canConsumeHorizontal: !!horizontalScrollUpdate && horizontalScrollUpdate.shouldConsume,
          horizontalIntentRatio: HORIZONTAL_INTENT_RATIO,
          verticalRecoverRatio: VERTICAL_RECOVER_RATIO
        });

        if (
          directionLock === 'x' &&
          !swipeStart.startedInTerminal &&
          swipeStart.horizontalScrollTarget &&
          horizontalScrollUpdate &&
          horizontalScrollUpdate.shouldConsume
        ) {
          swipeStart.horizontalScrollTarget.scrollLeft = horizontalScrollUpdate.nextScrollLeft;
          event.preventDefault();
        }
        if (!longPressTimer) {
          return;
        }
        const primaryDelta =
          directionLock === 'x'
            ? Math.abs(dx)
            : directionLock === 'y'
              ? Math.abs(dy)
              : Math.max(Math.abs(dx), Math.abs(dy));
        if (primaryDelta > LONG_PRESS_MOVE_CANCEL_PX) {
          clearLongPress();
        }
      },
      { capture: true, passive: false }
    );

    DOM.terminalWrap.addEventListener(
      'touchend',
      (event) => {
        clearLongPress();
        if (singleFingerScrollState && event.touches.length < 1) {
          endSingleFingerScrollMode();
          resetSwipeTracking();
          return;
        }
        if (touchSelectionState) {
          const endPoint = pointFromTouch(event.changedTouches && event.changedTouches[0]);
          completeTouchSelectionGesture(endPoint);
          const menuPoint = endPoint || touchSelectionState.lastPoint;
          if (hasActiveTerminalSelection()) {
            showClipboardMenuAtPoint(menuPoint);
          }
          resetSwipeTracking();
          return;
        }
        if (twoFingerState && event.touches.length < 2) {
          const mode = twoFingerState.mode;
          twoFingerState = null;
          if (mode === 'pinch') {
            const term = getTerm();
            if (term && typeof term.scheduleResize === 'function') {
              term.scheduleResize(true);
            }
          }
          resetSwipeTracking();
          return;
        }

        if (suppressTouchEnd) {
          suppressTouchEnd = false;
          resetSwipeTracking();
          return;
        }

        resetSwipeTracking();
      },
      { capture: true, passive: true }
    );

    DOM.terminalWrap.addEventListener(
      'touchcancel',
      () => {
        clearLongPress();
        resetSwipeTracking();
        twoFingerState = null;
        endSingleFingerScrollMode();
        endTouchSelection({
          clearTerminalSelection: true
        });
      },
      { capture: true, passive: true }
    );

    window.addEventListener(
      'blur',
      () => {
        resetGestureState();
      },
      { passive: true }
    );
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        resetGestureState();
      }
    });
  }

  return {
    bind,
    hideMenu
  };
}
