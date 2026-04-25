import {randomUUID} from 'node:crypto';
import process from 'node:process';
import type net from 'node:net';
import {attachJsonParser, openPersistentConnection, writeMessage} from './client.js';
import type {ServerMessage, SessionRecord} from './types.js';

export async function attachSession(sessionId: string): Promise<void> {
	const socket = await openPersistentConnection();
	const requestId = randomUUID();
	let attached = false;
	let cleanedUp = false;

	await new Promise<void>((resolve, reject) => {
		const restoreRawMode = () => {
			if (process.stdin.isTTY) {
				process.stdin.setRawMode?.(false);
			}
		};

		const cleanup = () => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;
			restoreRawMode();
			process.stdout.off('resize', onResize);
			process.stdin.off('data', onInput);
			stopParsing();
			socket.removeAllListeners('error');
			socket.removeAllListeners('close');
			if (!socket.destroyed) {
				socket.end();
			}
		};

		const finish = (error?: unknown) => {
			cleanup();
			if (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			resolve();
		};

		const onResize = () => {
			writeMessage(socket, {
				type: 'resize',
				sessionId,
				cols: process.stdout.columns || 80,
				rows: process.stdout.rows || 24,
			});
		};

		const onInput = (data: Buffer | string) => {
			const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
			if (chunk.includes(0x00)) {
				writeMessage(socket, {type: 'detach', sessionId});
				finish();
				return;
			}
			writeMessage(socket, {type: 'input', sessionId, data: chunk.toString('utf8')});
		};

		const stopParsing = attachJsonParser(socket, message => {
			if (message.type === 'response' && message.requestId === requestId) {
				if (!message.ok) {
					finish(new Error(message.error || 'attach failed'));
					return;
				}
				attached = true;
				if (process.stdin.isTTY) {
					process.stdin.setRawMode?.(true);
				}
				process.stdin.resume();
				process.stdin.on('data', onInput);
				process.stdout.on('resize', onResize);
				onResize();
				return;
			}

			if (message.type === 'output' && message.sessionId === sessionId) {
				process.stdout.write(message.data);
				return;
			}

			if (message.type === 'session-updated' && message.session.id === sessionId) {
				const session = message.session as SessionRecord;
				if (session.status === 'exited') {
					process.stdout.write(`\n\r[session exited: ${session.title}]\n`);
					finish();
				}
				return;
			}

			if (message.type === 'detached' && message.sessionId === sessionId) {
				finish();
			}
		});

		socket.once('error', error => finish(error));
		socket.once('close', () => {
			if (!cleanedUp && attached) {
				finish(new Error('daemon connection closed during attach'));
			}
		});

		writeMessage(socket, {type: 'attach', requestId, sessionId});
	});
}
