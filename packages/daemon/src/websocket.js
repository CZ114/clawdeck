const crypto = require("node:crypto");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function websocketAcceptKey(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }

  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function decodeClientFrames(buffer, onText, onClose) {
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket frame is too large");
      }
      length = Number(bigLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const payloadStart = offset + headerLength + maskLength;
    const payloadEnd = payloadStart + length;

    if (payloadEnd > buffer.length) {
      break;
    }

    let payload = buffer.subarray(payloadStart, payloadEnd);

    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    if (opcode === 0x1) {
      onText(payload.toString("utf8"));
    } else if (opcode === 0x8) {
      onClose();
    }

    offset = payloadEnd;
  }

  return buffer.subarray(offset);
}

function attachWebSocket(socket, handlers) {
  let buffer = Buffer.alloc(0);
  const client = {
    sendJson(message) {
      if (socket.destroyed) {
        return;
      }
      socket.write(encodeFrame(JSON.stringify(message)));
    },
    close() {
      if (!socket.destroyed) {
        socket.end(encodeFrame("", 0x8));
      }
    }
  };

  socket.on("data", (chunk) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = decodeClientFrames(
        buffer,
        (text) => handlers.onMessage(client, text),
        () => client.close()
      );
    } catch (error) {
      handlers.onError(client, error);
      client.close();
    }
  });

  socket.on("close", () => handlers.onClose(client));
  socket.on("error", (error) => handlers.onError(client, error));

  return client;
}

function acceptWebSocket(req, socket, handlers) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return null;
  }

  const accept = websocketAcceptKey(key);
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  return attachWebSocket(socket, handlers);
}

module.exports = {
  acceptWebSocket,
  encodeFrame
};
