/* Shared touch and pen swipe for a card: it follows the finger, a drag past the threshold calls
   onSwipe(1) for right or onSwipe(-1) for left, and a short drag springs back. Mouse drags are
   ignored, and a drag that starts on a control (the ignore selector) is left to that control.
   Used by the Confirm deck and the Home next-thing card. */

const IGNORE = 'button,a,input,textarea,select,summary';

// opts: when() is true while the card's screen is showing; card is the CSS selector of the
// swipeable card; ignore overrides the control selector; onSwipe(dir, el) runs on a far release.
// Returns handle(event): true when the event belonged to a swipe.
export function createSwipe({ when, card, ignore = IGNORE, onSwipe }) {
  let drag = null;
  return function handle(e) {
    if (e.type === 'pointerdown') {
      drag = null;
      if (!when() || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return false;
      const el = e.target.closest?.(card);
      if (!el || e.target.closest(ignore)) return false;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, on: false, el };
      return true;
    }
    if (!drag || e.pointerId !== drag.id) return false;
    // A redraw during the drag (resize, a scenario change) replaces the card element.
    if (!drag.el.isConnected) drag.el = document.querySelector(card) || drag.el;
    if (e.type === 'pointermove') {
      const dx = e.clientX - drag.x;
      if (!drag.on) {
        if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(e.clientY - drag.y)) return true;
        drag.on = true;
        drag.el.classList.add('drag');
      }
      drag.dx = dx;
      drag.el.style.transform = `translateX(${dx}px) rotate(${(dx / 30).toFixed(2)}deg)`;
      return true;
    }
    const d = drag;
    drag = null;
    const far = e.type === 'pointerup' && d.on && Math.abs(d.dx) >= Math.min(80, (d.el.offsetWidth || 320) * 0.25);
    d.el.classList.remove('drag');
    d.el.style.transform = '';
    if (far) onSwipe(d.dx > 0 ? 1 : -1, d.el);
    return true;
  };
}
