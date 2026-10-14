'use strict';

const Homey = require('homey');

class TapDialDevice extends Homey.Device {
  async onInit() {
    this.log('Hue Tap Dial is ready for short and long press events.');
  }
}

module.exports = TapDialDevice;
