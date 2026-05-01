const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function randomSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

class DeviceStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), ".claude-companion");
    this.filePath = path.join(this.dataDir, "devices.json");
    this.devices = [];
    this.load();
  }

  load() {
    const data = loadJson(this.filePath, { devices: [] });
    this.devices = Array.isArray(data.devices) ? data.devices : [];
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(
        {
          devices: this.devices
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }

  createDevice(deviceName, nowIso) {
    const authToken = randomSecret("devtok");
    const device = {
      deviceId: randomSecret("dev").slice(0, 18),
      deviceName: String(deviceName || "Unnamed device").slice(0, 80),
      tokenHash: tokenHash(authToken),
      createdAt: nowIso,
      lastSeenAt: nowIso,
      revokedAt: null
    };

    this.devices.push(device);
    this.save();

    return {
      device: this.publicDevice(device),
      authToken
    };
  }

  authenticate(token, nowIso) {
    if (!token) {
      return null;
    }

    const hash = tokenHash(token);
    const device = this.devices.find((item) => item.tokenHash === hash && !item.revokedAt);
    if (!device) {
      return null;
    }

    device.lastSeenAt = nowIso;
    this.save();
    return this.publicDevice(device);
  }

  revoke(deviceId, nowIso) {
    const device = this.devices.find((item) => item.deviceId === deviceId && !item.revokedAt);
    if (!device) {
      return null;
    }

    device.revokedAt = nowIso;
    this.save();
    return this.publicDevice(device);
  }

  list() {
    return this.devices.map((device) => this.publicDevice(device));
  }

  publicDevice(device) {
    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt
    };
  }
}

class PairingManager {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || 10 * 60 * 1000;
    this.rotate();
  }

  rotate() {
    const now = Date.now();
    this.token = randomSecret("pair");
    this.expiresAtMs = now + this.ttlMs;
  }

  current(nowIso) {
    if (Date.now() >= this.expiresAtMs) {
      this.rotate();
    }

    return {
      pairingToken: this.token,
      expiresAt: new Date(this.expiresAtMs).toISOString(),
      createdAt: nowIso
    };
  }

  consume(token) {
    const current = this.current(new Date().toISOString());
    if (!token || token !== current.pairingToken) {
      return false;
    }

    this.rotate();
    return true;
  }
}

module.exports = {
  DeviceStore,
  PairingManager,
  randomSecret
};
