// Test-only preload for an analysis worker thread (`--import` after tsx). Every network
// attempt inside the thread is reported to the test and then fails, so no request leaves.
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { parentPort } from 'node:worker_threads';

const blocked = (kind: string) => {
  parentPort?.postMessage({ type: 'network-attempt', kind });
  return new Error(`Network access is blocked in this test worker (${kind}).`);
};
globalThis.fetch = (async () => { throw blocked('fetch'); }) as typeof fetch;
// net.connect, http(s) requests and TLS all end in Socket#connect.
net.Socket.prototype.connect = function connect() { throw blocked('net.connect'); } as typeof net.Socket.prototype.connect;
tls.connect = (() => { throw blocked('tls.connect'); }) as typeof tls.connect;
dns.lookup = (() => { throw blocked('dns.lookup'); }) as unknown as typeof dns.lookup;
dns.promises.lookup = (async () => { throw blocked('dns.lookup'); }) as typeof dns.promises.lookup;
