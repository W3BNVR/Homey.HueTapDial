'use strict';

const Homey = require('homey');

class TapDialDriver extends Homey.Driver {
  async onInit() {
    this.triggerCards = {
      tap_dial_used: this.homey.flow.getDeviceTriggerCard('tap_dial_used'),
      button_pressed: this.homey.flow.getDeviceTriggerCard('button_pressed'),
      short_press: this.homey.flow.getDeviceTriggerCard('short_press'),
      long_press: this.homey.flow.getDeviceTriggerCard('long_press'),
      dial_rotated: this.homey.flow.getDeviceTriggerCard('dial_rotated'),
    };
    this.triggerCards.button_pressed.registerRunListener((args, state) =>
      String(args.button) === String(state.button) && args.action === state.action);
    for (const action of ['short_press', 'long_press']) {
      this.triggerCards[action].registerRunListener((args, state) => String(args.button) === String(state.button));
    }
  }

  async onPairListDevices() {
    const app = this.homey.app;
    if (!app.bridge) throw new Error('Configure the Hue Bridge IP address and application key in the app settings first.');
    return app.bridge.discoverTapDials();
  }

  onHueButtonEvent(resourceId, button, action) {
    let matchedDevices = 0;
    for (const device of this.getDevices()) {
      const buttonIds = device.getStoreValue('buttonIds') || [];
      if (!buttonIds.includes(resourceId)) continue;
      matchedDevices += 1;
      this.triggerCards.tap_dial_used.trigger(device, {
        activity: 'button',
        button: Number(button),
        action,
        direction: '',
        steps: 0,
        duration: 0,
        phase: '',
      }, {}).catch(error => this.error(error));
      this.triggerCards.button_pressed.trigger(device, {}, { button, action }).catch(error => this.error(error));
      this.triggerCards[action].trigger(device, {}, { button }).catch(error => this.error(error));
    }
    return matchedDevices;
  }

  onHueDialRotated(resourceId, tokens) {
    let matchedDevices = 0;
    for (const device of this.getDevices()) {
      const rotaryIds = device.getStoreValue('rotaryIds') || [];
      if (!rotaryIds.includes(resourceId)) continue;
      matchedDevices += 1;
      this.triggerCards.tap_dial_used.trigger(device, {
        activity: 'dial',
        button: 0,
        action: '',
        direction: tokens.direction,
        steps: tokens.steps,
        duration: tokens.duration,
        phase: tokens.phase,
      }, {}).catch(error => this.error(error));
      this.triggerCards.dial_rotated.trigger(device, tokens, {}).catch(error => this.error(error));
    }
    return matchedDevices;
  }
}

module.exports = TapDialDriver;
