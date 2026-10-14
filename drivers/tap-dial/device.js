'use strict';

const Homey = require('homey');

class TapDialDevice extends Homey.Device {
  async onInit() {
    this.log('Hue Tap Dial is ready for short press, long press and double click events.');
  }
}

module.exports = TapDialDevice;
