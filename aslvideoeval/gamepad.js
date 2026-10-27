import {DEFAULT_PAD} from './core.js';

// Edge-triggered commands: holding a button across a dialog transition never
// becomes a second click. A newly connected pad must first reach neutral.
export class GamepadInput {
  constructor({dispatch, status, bindings, modal, capture}) {
    Object.assign(this, {dispatch, status, bindings, modal, capture});
    this.previous = []; this.padId = null; this.armed = false; this.lastNav = 0;
    this.lastSeek = 0; this.visible = true; this.running = true;
    window.addEventListener('blur', () => {this.visible = false; this.armed = false;});
    window.addEventListener('focus', () => {this.visible = true;});
    document.addEventListener('visibilitychange', () => {this.visible = !document.hidden; if (!this.visible) this.armed = false;});
    this.poll = this.poll.bind(this); requestAnimationFrame(this.poll);
  }
  poll(now) {
    if (!this.running) return;
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    const pad = pads.find(Boolean);
    if (!pad) {
      if (this.padId !== null) this.status(null, true);
      this.padId = null; this.previous = []; this.armed = false;
    } else {
      const id = `${pad.index}:${pad.id}`;
      const pressed = pad.buttons.map(button => button.pressed || button.value > .6);
      if (id !== this.padId) {this.padId = id; this.armed = false; this.previous = pressed; this.status(pad, false);}
      const neutral = pressed.every(value => !value) && pad.axes.every(value => Math.abs(value) < .3);
      if (!this.armed && neutral && this.visible) this.armed = true;
      if (this.armed && this.visible) {
        const fresh = pressed.map((value, index) => value && !this.previous[index]);
        const capturing = this.capture(fresh);
        if (!capturing) {
          const mapping = {...DEFAULT_PAD, ...this.bindings()};
          for (const [command, button] of Object.entries(mapping)) {
            if (!['rewind', 'forward'].includes(command) && fresh[button]) {this.dispatch(command); break;}
          }
          if (!this.modal() && now - this.lastSeek > 130) {
            if (pressed[mapping.rewind]) {this.dispatch('seek', -1); this.lastSeek = now;}
            else if (pressed[mapping.forward]) {this.dispatch('seek', 1); this.lastSeek = now;}
          }
          const vertical = pressed[12] ? -1 : pressed[13] ? 1 : Math.abs(pad.axes[1] || 0) > .55 ? Math.sign(pad.axes[1]) : 0;
          const horizontal = pressed[14] ? -1 : pressed[15] ? 1 : Math.abs(pad.axes[0] || 0) > .55 ? Math.sign(pad.axes[0]) : 0;
          if ((vertical || horizontal) && now - this.lastNav > 220) {
            this.dispatch('navigate', {vertical, horizontal}); this.lastNav = now;
          }
        }
      }
      this.previous = pressed;
    }
    requestAnimationFrame(this.poll);
  }
}
