'use strict';

const Homey = require('homey');
const https = require('https');
const net = require('net');
const { EventEmitter } = require('events');

class HueBridge extends EventEmitter {
  constructor(ip, key, logger) {
    super();
    this.ip = ip;
    this.key = key;
    this.log = logger;
    this.closed = false;
    this.retry = 1000;
  }

  request(path) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: this.ip, port: 443, path, method: 'GET',
        headers: { 'hue-application-key': this.key, accept: 'application/json' },
        rejectUnauthorized: false, timeout: 10000,
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Hue Bridge returned HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Hue Bridge request timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  async discoverTapDials() {
    const [deviceResult, buttonResult, rotaryResult] = await Promise.all([
      this.request('/clip/v2/resource/device'),
      this.request('/clip/v2/resource/button').catch(() => ({ data: [] })),
      this.request('/clip/v2/resource/relative_rotary').catch(() => ({ data: [] })),
    ]);

    const buttonsByOwner = new Map();
    for (const button of buttonResult.data || []) {
      const ownerId = button.owner && button.owner.rid;
      if (!ownerId) continue;
      if (!buttonsByOwner.has(ownerId)) buttonsByOwner.set(ownerId, []);
      buttonsByOwner.get(ownerId).push(button.id);
    }
    const rotariesByOwner = new Map();
    for (const rotary of rotaryResult.data || []) {
      const ownerId = rotary.owner && rotary.owner.rid;
      if (!ownerId) continue;
      if (!rotariesByOwner.has(ownerId)) rotariesByOwner.set(ownerId, []);
      rotariesByOwner.get(ownerId).push(rotary.id);
    }

    const found = [];
    for (const device of (deviceResult.data || [])) {
      const model = device.product_data && device.product_data.model_id;
      const productName = device.product_data && device.product_data.product_name;
      const deviceName = device.metadata && device.metadata.name;
      const services = device.services || [];
      const buttonIds = [...new Set([
        ...services.filter(service => service.rtype === 'button').map(service => service.rid),
        ...(buttonsByOwner.get(device.id) || []),
      ])];
      const rotaryIds = [...new Set([
        ...services.filter(service => service.rtype === 'relative_rotary').map(service => service.rid),
        ...(rotariesByOwner.get(device.id) || []),
      ])];
      const isTapDial = model === 'RDM002'
        || /tap\s*dial/i.test(`${deviceName || ''} ${productName || ''}`)
        || (buttonIds.length >= 4 && rotaryIds.length > 0);
      if (!isTapDial || (buttonIds.length === 0 && rotaryIds.length === 0)) continue;
      found.push({
        name: deviceName || productName || 'Hue Tap Dial Switch',
        data: { id: device.id },
        store: { buttonIds, rotaryIds },
      });
    }
    this.log(`Hue discovery: ${found.length} Tap Dial device(s), ${buttonsByOwner.size} button owner(s), ${rotariesByOwner.size} rotary owner(s).`);
    return found;
  }

  connect() {
    if (this.closed) return;
    const req = https.get({
      hostname: this.ip, port: 443, path: '/eventstream/clip/v2',
      headers: { 'hue-application-key': this.key, accept: 'text/event-stream' },
      rejectUnauthorized: false, timeout: 0,
    }, res => {
      if (res.statusCode !== 200) {
        this.log(`Hue event stream returned HTTP ${res.statusCode}`);
        res.resume();
        return this.scheduleReconnect();
      }
      this.retry = 1000;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!data) continue;
          try {
            const events = JSON.parse(data);
            for (const event of events) for (const resource of (event.data || [])) this.emit('resource', resource);
          } catch (error) { this.log(`Could not parse Hue event: ${error.message}`); }
        }
      });
      res.on('end', () => this.scheduleReconnect());
      res.on('error', error => { this.log(`Hue event stream error: ${error.message}`); this.scheduleReconnect(); });
    });
    req.on('error', error => { this.log(`Hue event stream connection failed: ${error.message}`); this.scheduleReconnect(); });
    this.requestHandle = req;
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.retry;
    this.retry = Math.min(this.retry * 2, 60000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    if (this.requestHandle) this.requestHandle.destroy();
  }
}

class HueTapDialApp extends Homey.App {
  async onInit() {
    this.bridge = null;
    this.configureBridge();
    this.homey.settings.on('set', () => this.configureBridge());
  }

  configureBridge() {
    if (this.bridge) this.bridge.close();
    const ip = String(this.homey.settings.get('bridge_ip') || '').trim();
    const key = String(this.homey.settings.get('application_key') || '').trim();
    if (!ip || !key) {
      this.bridge = null;
      this.log('Add the Hue Bridge IP address and application key in app settings to connect.');
      return;
    }
    this.bridge = new HueBridge(ip, key, message => this.log(message));
    this.bridge.on('resource', resource => this.handleHueResource(resource));
    this.bridge.connect();
  }

  async createHueApplicationKey(ip) {
    const address = String(ip || '').trim();
    if (net.isIP(address) !== 4 || !this.isPrivateIPv4(address)) {
      return { ok: false, code: 'invalid_ip' };
    }

    const body = JSON.stringify({ devicetype: 'homey#tapdial' });
    try {
      const response = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: address,
          port: 443,
          path: '/api',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          rejectUnauthorized: false,
          timeout: 8000,
        }, res => {
          let responseBody = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { responseBody += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(responseBody)); } catch (error) { reject(new Error('invalid_response')); }
          });
        });
        req.on('timeout', () => req.destroy(new Error('bridge_timeout')));
        req.on('error', reject);
        req.end(body);
      });

      const result = Array.isArray(response) ? response[0] : null;
      const applicationKey = result && result.success && result.success.username;
      if (!applicationKey) {
        const hueError = result && result.error;
        if (hueError && hueError.type === 101) return { ok: false, code: 'link_button_not_pressed' };
        return { ok: false, code: 'bridge_rejected_request' };
      }

      await this.homey.settings.set('bridge_ip', address);
      await this.homey.settings.set('application_key', applicationKey);
      this.configureBridge();
      return { ok: true };
    } catch (error) {
      this.log(`Could not create Hue application key: ${error.message}`);
      return { ok: false, code: error.message === 'bridge_timeout' ? 'bridge_timeout' : 'bridge_unreachable' };
    }
  }

  isPrivateIPv4(address) {
    const octets = address.split('.').map(Number);
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }

  handleHueResource(resource) {
    const driver = this.homey.drivers.getDriver('tap-dial');
    if (resource && resource.type === 'button' && resource.button) {
      const report = resource.button.button_report;
      const event = report && report.event;
      const buttonNumber = String((resource.metadata && resource.metadata.control_id) || '');
      const names = { short_release: 'short_press', long_release: 'long_press', double_short_release: 'double_click' };
      const action = names[event];
      if (action && /^[1-4]$/.test(buttonNumber)) driver.onHueButtonEvent(resource.id, buttonNumber, action);
      return;
    }

    if (!resource || resource.type !== 'relative_rotary' || !resource.relative_rotary) return;
    const rotary = resource.relative_rotary;
    const event = rotary.last_event || rotary.rotary_report;
    if (!event || !event.rotation) return;
    const direction = event.rotation.direction === 'clock_wise' ? 'clockwise'
      : event.rotation.direction === 'counter_clock_wise' ? 'counterclockwise' : null;
    const steps = Number(event.rotation.steps);
    if (!direction || !Number.isFinite(steps)) return;
    driver.onHueDialRotated(resource.id, {
      direction,
      steps: Math.abs(steps),
      duration: Number(event.rotation.duration) || 0,
      phase: event.action || event.event || 'rotate',
    });
  }

  async onUninit() {
    if (this.bridge) this.bridge.close();
  }
}

module.exports = HueTapDialApp;
