/**
 * DSH Web - iOS composer keyboard shim.
 *
 * The composer is a Lexical contenteditable inside a large card
 * ([data-composer-card]). React's card mousedown handler focuses the editor
 * programmatically for taps that land outside the text surface (card padding,
 * the free space around the text line). iOS Safari only raises the software
 * keyboard for a focus that happens inside a touch it dispatched itself: a
 * programmatic focus shows the caret but no keyboard, and because the editor
 * is then ALREADY document.activeElement, tapping it again does not re-arm the
 * keyboard either - the composer is stuck with a caret and no keys.
 *
 * The fix runs at touchstart, while the touch is still being dispatched:
 *
 *   - tap inside the text surface, editor already focused, keyboard down:
 *       preventDefault + blur + focus. iOS never re-opens the keyboard for a
 *       tap on the already-focused element, so the focus cycle is what does.
 *   - tap in the card but outside the text surface (and not on a control):
 *       preventDefault + focus, with the caret at the end. Cancelling the
 *       touch also cancels the synthetic mouse events, so the card's own
 *       mousedown path cannot focus outside the gesture afterwards.
 *
 * Controls, chips (contenteditable=false), overlays and the no-session
 * workspace-picker trigger are left alone. The shim listens for touchstart
 * only, so it is inert on desktop.
 */
(function () {
  'use strict'

  var CONTROL = 'button, a, input, select, textarea, [role="button"], [role="tab"], '
    + '[role="menuitem"], [role="option"], [contenteditable="false"], [data-composer-overlay]'

  function keyboardUp() {
    var vv = window.visualViewport
    if (!vv) return false
    return vv.height < Math.round(document.documentElement.clientHeight) - 1
  }

  function editableIn(card) {
    var el = card.querySelector('[data-composer-input]')
    return el !== null && el.getAttribute('contenteditable') === 'true' ? el : null
  }

  function focusEnd(el) {
    if (document.activeElement === el) return
    el.focus({ preventScroll: true })
    try {
      var sel = window.getSelection()
      if (!sel) return
      var range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    } catch (e) {
      /* a cosmetic caret placement must never break editing */
    }
  }

  function rearm(el) {
    el.blur()
    focusEnd(el)
  }

  function onTouchStart(event) {
    var target = event.target
    if (!target || typeof target.closest !== 'function') return
    var card = target.closest('[data-composer-card]')
    if (card === null) return
    var editable = editableIn(card)
    if (editable === null) return
    if (target.closest(CONTROL) !== null) return

    if (editable.contains(target)) {
      if (document.activeElement !== editable || keyboardUp()) return
      event.preventDefault()
      rearm(editable)
      return
    }

    if (document.activeElement === editable) {
      event.preventDefault()
      if (!keyboardUp()) rearm(editable)
      return
    }

    event.preventDefault()
    focusEnd(editable)
  }

  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false })
})()
