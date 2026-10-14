'use strict';

const Homey = require('homey');

class TapDialDriver extends Homey.Driver {
  async onInit() {
    this.triggerCards = {
      short_press: this.homey.flow.getDeviceTriggerCard('short_press'),
      long_press: this.homey.flow.getDeviceTriggerCard('long_press'),
      double_click: this.homey.flow.getDeviceTriggerCard('double_click'),
      dial_rotated: this.homey.flow.getDeviceTriggerCard('dial_rotated'),
    };
    for (const card of Object.values(this.triggerCards)) {
      card.registerRunListener((args, state) => String(args.button) === String(state.button));
    }
  }

  async onPairListDevices() {
    const app = this.homey.app;
    if (!app.bridge) throw new Error('Configure the Hue Bridge IP address and application key in the app settings first.');
    return app.bridge.discoverTapDials();
  }

  onHueButtonEvent(resourceId, button, action) {
    for (const device of this.getDevices()) {
      const buttonIds = device.getStoreValue('buttonIds') || [];
      if (!buttonIds.includes(resourceId)) continue;
      this.triggerCards[action].trigger(device, {}, { button }).catch(error => this.error(error));
    }
  }

  onHueDialRotated(resourceId, tokens) {
    for (const device of this.getDevices()) {
      const rotaryIds = device.getStoreValue('rotaryIds') || [];
      if (!rotaryIds.includes(resourceId)) continue;
      this.triggerCards.dial_rotated.trigger(device, tokens, {}).catch(error => this.error(error));
    }
  }
}

module.exports = TapDialDriver;
