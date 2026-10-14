'use strict';

module.exports = {
  async createHueApplicationKey({ homey, body }) {
    return homey.app.createHueApplicationKey(body && body.ip);
  },
  async getHueBridgeConnectionStatus({ homey }) {
    return homey.app.getBridgeConnectionStatus();
  },
};
