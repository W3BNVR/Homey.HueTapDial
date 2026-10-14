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
    this.connectionStatus = 'connecting';
    this.buttonNumbers = new Map();
  }

  setConnectionStatus(status) {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    this.emit('connection-status', status);
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
    let buttonError = null;
    let rotaryError = null;
    const [deviceResult, buttonResult, rotaryResult] = await Promise.all([
      this.request('/clip/v2/resource/device'),
      this.request('/clip/v2/resource/button').catch(error => {
        buttonError = error.message;
        this.log(`Hue button discovery request failed: ${error.message}`);
        return { data: [] };
      }),
      this.request('/clip/v2/resource/relative_rotary').catch(error => {
        rotaryError = error.message;
        this.log(`Hue rotary discovery request failed: ${error.message}`);
        return { data: [] };
      }),
    ]);

    const buttonsByOwner = new Map();
    this.buttonNumbers.clear();
    for (const button of buttonResult.data || []) {
      const controlId = button.metadata && button.metadata.control_id;
      if (controlId !== undefined && controlId !== null) this.buttonNumbers.set(button.id, String(controlId));
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
      // The device resource is the authoritative product identifier. Keep a
      // Tap Dial visible even when a Bridge firmware omits its child resources
      // from the device response; otherwise pairing silently shows no results.
      if (!isTapDial) continue;
      found.push({
        name: deviceName || productName || 'Hue Tap Dial Switch',
        data: { id: device.id },
        store: { buttonIds, rotaryIds },
      });
    }
    const candidates = (deviceResult.data || []).filter(device => {
      const model = device.product_data && device.product_data.model_id;
      const names = `${device.metadata && device.metadata.name || ''} ${device.product_data && device.product_data.product_name || ''}`;
      return model === 'RDM002' || /tap\s*dial/i.test(names);
    });
    const candidateSummary = candidates.map(device => {
      const name = device.metadata && device.metadata.name || 'unnamed';
      const model = device.product_data && device.product_data.model_id || 'unknown model';
      const paired = found.some(item => item.data.id === device.id);
      return `${name} (${model}, ${paired ? 'paired' : 'missing services'})`;
    }).join('; ') || 'none';
    this.lastDiscovery = {
      deviceCount: (deviceResult.data || []).length,
      buttonCount: (buttonResult.data || []).length,
      rotaryCount: (rotaryResult.data || []).length,
      candidates: candidates.map(device => ({
        name: device.metadata && device.metadata.name || 'unnamed',
        model: device.product_data && device.product_data.model_id || 'unknown',
        buttonCount: found.find(item => item.data.id === device.id)?.store.buttonIds.length || 0,
        rotaryCount: found.find(item => item.data.id === device.id)?.store.rotaryIds.length || 0,
      })),
      errors: [buttonError, rotaryError].filter(Boolean),
    };
    this.log(`Hue discovery: ${found.length} Tap Dial device(s) from ${deviceResult.data?.length || 0} devices; ${buttonResult.data?.length || 0} buttons, ${rotaryResult.data?.length || 0} rotaries. Candidates: ${candidateSummary}.`);
    return found;
  }

  async refreshButtonNumbers() {
    const result = await this.request('/clip/v2/resource/button');
    this.buttonNumbers.clear();
    for (const button of result.data || []) {
      const controlId = button.metadata && button.metadata.control_id;
      if (controlId !== undefined && controlId !== null) this.buttonNumbers.set(button.id, String(controlId));
    }
    this.log(`Loaded button numbers for ${this.buttonNumbers.size} Hue button resources.`);
  }

  getButtonNumber(resourceId) {
    return this.buttonNumbers.get(resourceId) || null;
  }

  connect() {
    if (this.closed) return;
    this.setConnectionStatus('connecting');
    const req = https.get({
      hostname: this.ip, port: 443, path: '/eventstream/clip/v2',
      headers: { 'hue-application-key': this.key, accept: 'text/event-stream' },
      rejectUnauthorized: false, timeout: 0,
    }, res => {
      if (res.statusCode !== 200) {
        this.log(`Hue event stream returned HTTP ${res.statusCode}`);
        this.setConnectionStatus(res.statusCode === 401 || res.statusCode === 403 ? 'unauthorized' : 'disconnected');
        res.resume();
        return this.scheduleReconnect();
      }
      this.setConnectionStatus('connected');
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
    this.setConnectionStatus('reconnecting');
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
    this.lastHueEvent = null;
    this.lastLongPressAt = new Map();
    this.pendingShortPresses = new Map();
    this.configureBridge();
    this.homey.settings.on('set', () => this.configureBridge());
  }

  async configureBridge() {
    if (this.bridge) this.bridge.close();
    const ip = String(this.homey.settings.get('bridge_ip') || '').trim();
    const key = String(this.homey.settings.get('application_key') || '').trim();
    if (!ip || !key) {
      this.bridge = null;
      this.log('Add the Hue Bridge IP address and application key in app settings to connect.');
      return;
    }
    const bridge = new HueBridge(ip, key, message => this.log(message));
    this.bridge = bridge;
    bridge.on('resource', resource => this.handleHueResource(resource));
    try {
      await bridge.refreshButtonNumbers();
    } catch (error) {
      this.log(`Could not load Hue button numbers: ${error.message}`);
    }
    if (this.bridge === bridge) bridge.connect();
  }

  getBridgeConnectionStatus() {
    if (!this.bridge) return { status: 'not_configured', configured: false };
    return { status: this.bridge.connectionStatus, configured: true };
  }

  async diagnoseTapDialDiscovery() {
    if (!this.bridge) return { ok: false, status: 'not_configured' };
    try {
      const devices = await this.bridge.discoverTapDials();
      return {
        ok: true,
        status: this.bridge.connectionStatus,
        discovery: this.bridge.lastDiscovery,
        foundCount: devices.length,
        lastEvent: this.lastHueEvent,
      };
    } catch (error) {
      this.log(`Hue Tap Dial diagnostic failed: ${error.message}`);
      return { ok: false, status: this.bridge.connectionStatus, error: error.message };
    }
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
      const buttonNumber = String(
        (resource.metadata && resource.metadata.control_id)
        || this.bridge.getButtonNumber(resource.id)
        || '',
      );
      const names = {
        short_release: 'short_press',
        long_press: 'long_press',
        long_release: 'long_press',
        double_short_release: 'double_click',
      };
      const action = names[event];
      const pressKey = `${resource.id}:${buttonNumber}`;
      let ignoredReason = null;
      if (event === 'long_press') this.lastLongPressAt.set(resource.id, Date.now());
      if (event === 'long_release') {
        const lastLongPress = this.lastLongPressAt.get(resource.id) || 0;
        this.lastLongPressAt.delete(resource.id);
        if (Date.now() - lastLongPress < 2000) ignoredReason = 'duplicate_long_release';
      }

      // Hue bridges commonly report two quick taps as two short_release events
      // instead of a dedicated double_short_release event. Delay singles briefly
      // so the pair can be recognized without emitting two single actions.
      if (event === 'short_release' && /^[1-4]$/.test(buttonNumber)) {
        const pending = this.pendingShortPresses.get(pressKey);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingShortPresses.delete(pressKey);
          const matchedDevices = driver.onHueButtonEvent(resource.id, buttonNumber, 'double_click');
          this.recordHueButtonEvent(buttonNumber, event, 'double_click', matchedDevices, 'double_click_detected');
          return;
        }
        const timer = setTimeout(() => {
          this.pendingShortPresses.delete(pressKey);
          const matchedDevices = driver.onHueButtonEvent(resource.id, buttonNumber, 'short_press');
          this.recordHueButtonEvent(buttonNumber, event, 'short_press', matchedDevices, null);
        }, 450);
        this.pendingShortPresses.set(pressKey, { timer, resourceId: resource.id, buttonNumber, event });
        this.lastHueEvent = {
          kind: 'button', controlId: buttonNumber, event, action: 'waiting_for_second_tap',
          matchedDevices: 0, ignoredReason: null, time: new Date().toISOString(),
        };
        this.log(`Hue button event: button ${buttonNumber} short_release; waiting briefly to distinguish a single tap from a double click.`);
        return;
      }

      // A non-short event ends the double-click window and releases any pending
      // single for this button before dispatching the new action.
      if (event !== 'short_release') {
        const pending = this.pendingShortPresses.get(pressKey);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingShortPresses.delete(pressKey);
          if (event !== 'double_short_release') {
            const pendingMatches = driver.onHueButtonEvent(pending.resourceId, pending.buttonNumber, 'short_press');
            this.recordHueButtonEvent(pending.buttonNumber, pending.event, 'short_press', pendingMatches, null);
          }
        }
      }

      let matchedDevices = 0;
      if (!ignoredReason && action && /^[1-4]$/.test(buttonNumber)) {
        matchedDevices = driver.onHueButtonEvent(resource.id, buttonNumber, action);
      }
      this.recordHueButtonEvent(buttonNumber, event, action, matchedDevices, ignoredReason);
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
    const matchedDevices = driver.onHueDialRotated(resource.id, {
      direction,
      steps: Math.abs(steps),
      duration: Number(event.rotation.duration) || 0,
      phase: event.action || event.event || 'rotate',
    });
    this.lastHueEvent = {
      kind: 'rotary',
      direction,
      steps: Math.abs(steps),
      matchedDevices,
      time: new Date().toISOString(),
    };
    this.log(`Hue rotary event: ${direction}, ${Math.abs(steps)} step(s); matched Homey devices: ${matchedDevices}.`);
  }

  recordHueButtonEvent(buttonNumber, event, action, matchedDevices, ignoredReason) {
    this.lastHueEvent = {
      kind: 'button',
      controlId: buttonNumber || 'unknown',
      event: event || 'unknown',
      action: action || 'unmapped',
      matchedDevices,
      ignoredReason,
      time: new Date().toISOString(),
    };
    this.log(`Hue button event: button ${buttonNumber || '?'} ${event || 'unknown'} -> ${action || 'ignored'}; matched Homey devices: ${matchedDevices}${ignoredReason ? ` (${ignoredReason})` : ''}.`);
  }

  async onUninit() {
    if (this.bridge) this.bridge.close();
  }
}

module.exports = HueTapDialApp;
