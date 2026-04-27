import {randomUUID} from 'node:crypto';
import process from 'node:process';
import type net from 'node:net';
import {attachJsonParser, openPersistentConnection, writeMessage} from './client.js';
import type {AttachTarget, SessionRecord} from './types.js';

interface AttachSessionOptions {
	title?: string;
	cwd?: string;
}

function clearTerminalScreen(): void {
	if (process.stdout.isTTY) {
		process.stdout.write('\x1b[2J\x1b[H');
	}
}

function attachTargetLabel(target: AttachTarget): string {
	return target === 'terminal' ? 'Terminal' : 'Agent';
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function compactPath(value: string | undefined, maxLength: number): string | undefined {
	if (!value || value.length <= maxLength) {
		return value;
	}
	if (maxLength <= 3) {
		return value.slice(-maxLength);
	}
	return `…${value.slice(-(maxLength - 1))}`;
}

function writeAttachBanner(sessionId: string, target: AttachTarget, options: AttachSessionOptions): void {
	const title = options.title ?? sessionId;
	const label = attachTargetLabel(target);
	const terminalWidth = process.stdout.columns || 80;
	const width = Math.max(44, Math.min(terminalWidth, 88));
	const cwd = compactPath(options.cwd, Math.max(12, width - title.length - label.length - 18));
	const location = cwd ? ` • ${cwd}` : '';
	const headline = `deckhand ${label}: ${title}${location}`;
	const help = 'Ctrl+Space returns to deckhand';
	const border = '─'.repeat(Math.max(0, width - 2));
	const formatLine = (line: string) => {
		const content = line.length > width - 4 ? `${line.slice(0, width - 5)}…` : line;
		return `│ ${content}${' '.repeat(Math.max(0, width - content.length - 3))}│`;
	};

	clearTerminalScreen();
	process.stdout.write(`┌${border}┐\n`);
	process.stdout.write(`${formatLine(headline)}\n`);
	process.stdout.write(`${formatLine(help)}\n`);
	process.stdout.write(`└${border}┘\n\n`);
}

export async function attachSession(sessionId: string, target: AttachTarget = 'agent', options: AttachSessionOptions = {}): Promise<void> {
	writeAttachBanner(sessionId, target, options);
	await delay(650);
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
				type: target === 'terminal' ? 'terminal-resize' : 'resize',
				sessionId,
				cols: process.stdout.columns || 80,
				rows: process.stdout.rows || 24,
			});
		};

		const onInput = (data: Buffer | string) => {
			const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
			if (chunk.includes(0x00)) {
				writeMessage(socket, {type: target === 'terminal' ? 'terminal-detach' : 'detach', sessionId});
				finish();
				return;
			}
			writeMessage(socket, {type: target === 'terminal' ? 'terminal-input' : 'input', sessionId, data: chunk.toString('utf8')});
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

			if ((message.type === 'output' || message.type === 'terminal-output') && message.sessionId === sessionId) {
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

			if ((message.type === 'detached' || message.type === 'terminal-detached') && message.sessionId === sessionId) {
				finish();
			}
		});

		socket.once('error', error => finish(error));
		socket.once('close', () => {
			if (!cleanedUp && attached) {
				finish(new Error('daemon connection closed during attach'));
			}
		});

		writeMessage(socket, {type: target === 'terminal' ? 'attach-terminal' : 'attach', requestId, sessionId});
	});
}
