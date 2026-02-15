import { DOM } from './state.js';

const DIRECTION_LOCK_THRESHOLD_PX = 8;
const LONG_PRESS_MS = 560;
const LONG_PRESS_MOVE_CANCEL_PX = 12;

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

export function createGestures({ getTerm, toast }) {
  let menuEl = null;
  let longPressTimer = 0;
  let longPressPoint = null;
  let suppressTouchEnd = false;
  let swipeStart = null;
  let directionLock = '';
  let pinchState = null;

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

    menuEl.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action]');
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
      }
    });

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!menuEl || menuEl.hidden) {
          return;
        }
        if (menuEl.contains(event.target)) {
          return;
        }
        hideMenu();
      },
      { passive: true }
    );

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

  function bind() {
    if (!DOM.terminalWrap) {
      return;
    }

    DOM.terminalWrap.addEventListener(
      'touchstart',
      (event) => {
        hideMenu();
        const touches = event.touches;
        if (touches.length === 2) {
          clearLongPress();
          suppressTouchEnd = false;
          swipeStart = null;
          directionLock = '';
          const term = getTerm();
          pinchState = {
            baseDistance: touchDistance(touches[0], touches[1]),
            baseFontSize: term && typeof term.getFontSize === 'function' ? term.getFontSize() : 14
          };
          return;
        }
        if (touches.length !== 1) {
          clearLongPress();
          swipeStart = null;
          directionLock = '';
          pinchState = null;
          return;
        }

        pinchState = null;
        const touch = touches[0];
        const horizontalScrollTarget = resolveHorizontalScrollTarget(event.target);
        swipeStart = {
          x: touch.clientX,
          y: touch.clientY,
          horizontalScrollTarget,
          horizontalScrollLeft: horizontalScrollTarget ? horizontalScrollTarget.scrollLeft : 0
        };
        directionLock = '';
        longPressPoint = {
          x: touch.clientX,
          y: touch.clientY
        };
        clearLongPress();
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0;
          if (!longPressPoint) {
            return;
          }
          suppressTouchEnd = true;
          showMenu(longPressPoint.x, longPressPoint.y);
        }, LONG_PRESS_MS);
      },
      { passive: true }
    );

    DOM.terminalWrap.addEventListener(
      'touchmove',
      (event) => {
        const touches = event.touches;
        if (pinchState && touches.length === 2) {
          clearLongPress();
          const term = getTerm();
          if (!term || typeof term.scaleFont !== 'function') {
            return;
          }
          const nextDistance = touchDistance(touches[0], touches[1]);
          if (!Number.isFinite(nextDistance) || nextDistance <= 0 || pinchState.baseDistance <= 0) {
            return;
          }
          const scale = nextDistance / pinchState.baseDistance;
          term.scaleFont(pinchState.baseFontSize, scale);
          event.preventDefault();
          return;
        }

        if (touches.length !== 1 || !swipeStart) {
          return;
        }
        const touch = touches[0];
        const dx = touch.clientX - swipeStart.x;
        const dy = touch.clientY - swipeStart.y;
        if (
          !directionLock &&
          (Math.abs(dx) >= DIRECTION_LOCK_THRESHOLD_PX || Math.abs(dy) >= DIRECTION_LOCK_THRESHOLD_PX)
        ) {
          directionLock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        }
        if (directionLock === 'x' && swipeStart.horizontalScrollTarget) {
          const scroller = swipeStart.horizontalScrollTarget;
          const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
          if (maxScrollLeft > 0) {
            const nextScrollLeft = Math.max(
              0,
              Math.min(maxScrollLeft, swipeStart.horizontalScrollLeft - dx)
            );
            if (Math.abs(nextScrollLeft - scroller.scrollLeft) > 0.5) {
              scroller.scrollLeft = nextScrollLeft;
            }
            event.preventDefault();
          }
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
      { passive: false }
    );

    DOM.terminalWrap.addEventListener(
      'touchend',
      () => {
        clearLongPress();
        const term = getTerm();
        if (pinchState) {
          pinchState = null;
          if (term && typeof term.scheduleResize === 'function') {
            term.scheduleResize(true);
          }
          swipeStart = null;
          directionLock = '';
          return;
        }

        if (suppressTouchEnd) {
          suppressTouchEnd = false;
          swipeStart = null;
          directionLock = '';
          return;
        }

        swipeStart = null;
        directionLock = '';
      },
      { passive: true }
    );

    DOM.terminalWrap.addEventListener(
      'touchcancel',
      () => {
        clearLongPress();
        swipeStart = null;
        directionLock = '';
        pinchState = null;
      },
      { passive: true }
    );
  }

  return {
    bind,
    hideMenu
  };
}
