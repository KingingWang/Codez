import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import {
  parseWebRemoteControlE2eeWirePayload,
  WEB_REMOTE_CONTROL_E2EE_VERSION,
  type WebRemoteControlE2eeRecord,
  type WebRemoteControlE2eeWirePayload,
} from "@codez/shared";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const RECEIVE_WINDOW = 1024;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("e2ee.invalidBase64");
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function base64url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64url(input: string, length: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(input)) throw new Error("e2ee.invalidToken");
  const raw = input.replace(/-/gu, "+").replace(/_/gu, "/");
  const decoded = decodeBase64(raw.padEnd(Math.ceil(raw.length / 4) * 4, "="));
  if (decoded.length !== length || base64url(decoded) !== input) {
    throw new Error("e2ee.invalidToken");
  }
  return decoded;
}

function verifyProof(actual: string, expected: Uint8Array): void {
  const candidate = fromBase64url(actual, 32);
  let difference = 0;
  for (let index = 0; index < 32; index += 1) {
    difference |= candidate[index]! ^ expected[index]!;
  }
  if (difference !== 0) throw new Error("e2ee.authenticationFailed");
}

function nonceFor(prefix: Uint8Array, sequence: number): Uint8Array {
  const nonce = new Uint8Array(24);
  nonce.set(prefix);
  new DataView(nonce.buffer).setBigUint64(16, BigInt(sequence), false);
  return nonce;
}

function transcript(
  deviceSid: string,
  hello: Extract<WebRemoteControlE2eeWirePayload, { zcode_type: "e2ee-hello" }>,
  response: Pick<
    Extract<WebRemoteControlE2eeWirePayload, { zcode_type: "e2ee-response" }>,
    "publicKey" | "nonce"
  >,
): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "codez-mobile-e2ee-v1",
      deviceSid,
      hello.publicKey,
      hello.nonce,
      response.publicKey,
      response.nonce,
    ]),
  );
}

export function generateWebRemoteControlPairingKey(): string {
  return base64url(randomBytes(32));
}

interface E2eeSessionOptions {
  role: "terminal" | "device";
  deviceSid: string;
  pairingKey: string;
  send(payload: WebRemoteControlE2eeWirePayload): void;
}

type AcceptResult =
  | { kind: "handshake" | "ready" | "duplicate" }
  | { kind: "payload" | "duplicate-rpc"; payload: unknown };

export function createWebRemoteControlE2eeSession(options: E2eeSessionOptions) {
  const pairingKey = fromBase64url(options.pairingKey, 32);
  const { deviceSid, role } = options;
  let phase: "initial" | "hello" | "response" | "finish" | "ready" | "disposed" = "initial";
  let secret: Uint8Array | undefined;
  let hello: Extract<WebRemoteControlE2eeWirePayload, { zcode_type: "e2ee-hello" }> | undefined;
  let proofTranscript: Uint8Array | undefined;
  let epoch = "";
  let sendKey: Uint8Array | undefined;
  let receiveKey: Uint8Array | undefined;
  let sendPrefix: Uint8Array | undefined;
  let receivePrefix: Uint8Array | undefined;
  let nextSequence = 1;
  let highestReceived = 0;
  const received = new Set<number>();

  function derive(peerPublicKey: string, proof: Uint8Array): void {
    if (!secret) throw new Error("e2ee.missingEphemeralKey");
    const shared = x25519.getSharedSecret(secret, fromBase64url(peerPublicKey, 32));
    const material = hkdf(sha256, shared, pairingKey, proof, 96);
    const deviceKey = material.slice(0, 32);
    const terminalKey = material.slice(32, 64);
    const devicePrefix = material.slice(64, 80);
    const terminalPrefix = material.slice(80, 96);
    sendKey = role === "device" ? deviceKey : terminalKey;
    receiveKey = role === "device" ? terminalKey : deviceKey;
    sendPrefix = role === "device" ? devicePrefix : terminalPrefix;
    receivePrefix = role === "device" ? terminalPrefix : devicePrefix;
    epoch = base64url(sha256(proof).slice(0, 16));
    shared.fill(0);
    material.fill(0);
    secret.fill(0);
    secret = undefined;
  }

  function encodeRecord(value: unknown): WebRemoteControlE2eeRecord {
    if (!sendKey || !sendPrefix || (phase !== "ready" && phase !== "finish")) {
      throw new Error("e2ee.notReady");
    }
    if (nextSequence >= Number.MAX_SAFE_INTEGER) throw new Error("e2ee.sequenceExhausted");
    const n = nextSequence++;
    const aad = encoder.encode(
      JSON.stringify([WEB_REMOTE_CONTROL_E2EE_VERSION, deviceSid, epoch, role, n]),
    );
    const ciphertext = xchacha20poly1305(sendKey, nonceFor(sendPrefix, n), aad).encrypt(
      encoder.encode(JSON.stringify(value)),
    );
    return {
      zcode_type: "e2ee-record",
      v: WEB_REMOTE_CONTROL_E2EE_VERSION,
      epoch,
      n,
      ciphertext: encodeBase64(ciphertext),
    };
  }

  function decodeRecord(record: WebRemoteControlE2eeRecord): AcceptResult {
    if (!receiveKey || !receivePrefix || record.epoch !== epoch) {
      throw new Error("e2ee.staleEpoch");
    }
    if (record.n <= highestReceived - RECEIVE_WINDOW) throw new Error("e2ee.staleRecord");
    const sender = role === "device" ? "terminal" : "device";
    const aad = encoder.encode(
      JSON.stringify([WEB_REMOTE_CONTROL_E2EE_VERSION, deviceSid, epoch, sender, record.n]),
    );
    const ciphertext = decodeBase64(record.ciphertext);
    if (encodeBase64(ciphertext) !== record.ciphertext) {
      throw new Error("e2ee.invalidCiphertext");
    }
    const plaintext = xchacha20poly1305(receiveKey, nonceFor(receivePrefix, record.n), aad).decrypt(
      ciphertext,
    );
    const value = JSON.parse(decoder.decode(plaintext)) as { kind?: unknown; payload?: unknown };
    if (role === "terminal" && phase === "finish") {
      if (value.kind !== "ready") throw new Error("e2ee.expectedReady");
      highestReceived = record.n;
      received.add(record.n);
      phase = "ready";
      return { kind: "ready" };
    }
    if (phase === "ready" && value.kind === "ready" && received.has(record.n)) {
      return { kind: "duplicate" };
    }
    if (phase !== "ready" || value.kind !== "app") throw new Error("e2ee.invalidRecord");
    const duplicate = received.has(record.n);
    if (!duplicate) {
      highestReceived = Math.max(highestReceived, record.n);
      received.add(record.n);
      for (const sequence of received) {
        if (sequence <= highestReceived - RECEIVE_WINDOW) received.delete(sequence);
      }
    }
    if (duplicate) {
      const payload = value.payload;
      if (
        payload &&
        typeof payload === "object" &&
        "zcode_type" in payload &&
        (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack")
      ) {
        return { kind: "duplicate-rpc", payload };
      }
      return { kind: "duplicate" };
    }
    return { kind: "payload", payload: value.payload };
  }

  return {
    isReady: () => phase === "ready",
    start(): void {
      if (phase !== "initial") throw new Error("e2ee.invalidHandshakeState");
      if (role === "device") return;
      secret = randomBytes(32);
      hello = {
        zcode_type: "e2ee-hello",
        v: WEB_REMOTE_CONTROL_E2EE_VERSION,
        sid: deviceSid,
        publicKey: base64url(x25519.getPublicKey(secret)),
        nonce: base64url(randomBytes(16)),
      };
      phase = "hello";
      options.send(hello);
    },
    accept(input: unknown): AcceptResult {
      if (phase === "disposed") throw new Error("e2ee.disposed");
      const payload = parseWebRemoteControlE2eeWirePayload(input);
      if (!payload) throw new Error("e2ee.invalidWire");
      if (payload.zcode_type === "e2ee-record") return decodeRecord(payload);
      if (payload.sid !== deviceSid) throw new Error("e2ee.wrongDevice");
      if (role === "device" && phase === "initial" && payload.zcode_type === "e2ee-hello") {
        hello = payload;
        secret = randomBytes(32);
        const responseFields = {
          publicKey: base64url(x25519.getPublicKey(secret)),
          nonce: base64url(randomBytes(16)),
        };
        proofTranscript = transcript(deviceSid, hello, responseFields);
        derive(hello.publicKey, proofTranscript);
        phase = "response";
        options.send({
          zcode_type: "e2ee-response",
          v: WEB_REMOTE_CONTROL_E2EE_VERSION,
          sid: deviceSid,
          ...responseFields,
          proof: base64url(
            hmac(sha256, pairingKey, encoder.encode(`device:${base64url(proofTranscript)}`)),
          ),
        });
        return { kind: "handshake" };
      }
      if (role === "terminal" && phase === "hello" && payload.zcode_type === "e2ee-response") {
        if (!hello || !secret) throw new Error("e2ee.invalidHandshakeState");
        proofTranscript = transcript(deviceSid, hello, payload);
        verifyProof(
          payload.proof,
          hmac(sha256, pairingKey, encoder.encode(`device:${base64url(proofTranscript)}`)),
        );
        derive(payload.publicKey, proofTranscript);
        phase = "finish";
        options.send({
          zcode_type: "e2ee-finish",
          v: WEB_REMOTE_CONTROL_E2EE_VERSION,
          sid: deviceSid,
          proof: base64url(
            hmac(sha256, pairingKey, encoder.encode(`terminal:${base64url(proofTranscript)}`)),
          ),
        });
        return { kind: "handshake" };
      }
      if (role === "device" && phase === "response" && payload.zcode_type === "e2ee-finish") {
        if (!proofTranscript) throw new Error("e2ee.invalidHandshakeState");
        verifyProof(
          payload.proof,
          hmac(sha256, pairingKey, encoder.encode(`terminal:${base64url(proofTranscript)}`)),
        );
        phase = "ready";
        options.send(encodeRecord({ kind: "ready" }));
        return { kind: "ready" };
      }
      throw new Error("e2ee.invalidHandshakeState");
    },
    prepare(payload: unknown): WebRemoteControlE2eeRecord {
      if (phase !== "ready") throw new Error("e2ee.notReady");
      return encodeRecord({ kind: "app", payload });
    },
    dispose(): void {
      secret?.fill(0);
      sendKey?.fill(0);
      receiveKey?.fill(0);
      sendPrefix?.fill(0);
      receivePrefix?.fill(0);
      pairingKey.fill(0);
      secret = undefined;
      sendKey = undefined;
      receiveKey = undefined;
      phase = "disposed";
      received.clear();
    },
  };
}
