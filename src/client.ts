import fs from 'node:fs/promises';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {getCliEntryPath, getProjectRoot, getSocketPath, isDevRuntime} from './paths.js';
import type {ClientRequest, CreateSessionInput, PreviewRecord, ServerMessage, SessionRecord} from './types.js';

function createConnection(): Promise<net.Socket> {
	const socketPath = getSocketPath();
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once('connect', () => resolve(socket));
		socket.once('error', reject);
	});
}

function writeMessage(socket: net.Socket, message: ClientRequest): void {
	socket.write(`${JSON.stringify(message)}\n`);
}

function attachJsonParser(socket: net.Socket, onMessage: (message: ServerMessage) => void): () => void {
	let buffer = '';
	const handleData = (chunk: Buffer | string) => {
		buffer += chunk.toString();
		while (true) {
			const newlineIndex = buffer.indexOf('\n');
			if (newlineIndex === -1) {
				break;
			}
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			onMessage(JSON.parse(line) as ServerMessage);
		}
	};
	socket.on('data', handleData);
	return () => {
		socket.off('data', handleData);
	};
}

export async function request<T = unknown>(message: Extract<ClientRequest, {requestId: string}>): Promise<T> {
	const socket = await createConnection();
	return new Promise<T>((resolve, reject) => {
		let done = false;
		const cleanup = attachJsonParser(socket, payload => {
			if (payload.type !== 'response' || payload.requestId !== message.requestId) {
				return;
			}
			done = true;
			socket.end();
			if (!payload.ok) {
				reject(new Error(payload.error || 'daemon request failed'));
				return;
			}
			resolve(payload.data as T);
		});
		socket.once('error', error => {
			if (!done) {
				reject(error);
			}
		});
		socket.once('close', () => {
			cleanup();
			if (!done) {
				reject(new Error('daemon connection closed before response'));
			}
		});
		writeMessage(socket, message);
	});
}

const PROTOCOL_VERSION = 4;

async function ping(): Promise<void> {
	const response = await request<{ok: true; version?: number}>({type: 'ping', requestId: randomUUID()});
	if (response.version !== PROTOCOL_VERSION) {
		throw new Error(`daemon protocol mismatch: expected v${PROTOCOL_VERSION}, got ${String(response.version)}`);
	}
}

function spawnDaemon(): void {
	const cliPath = getCliEntryPath();
	const args = isDevRuntime() ? ['--import', 'tsx', cliPath, '--daemon'] : [cliPath, '--daemon'];
	const child = spawn(process.execPath, args, {
		cwd: getProjectRoot(),
		env: {...process.env},
		detached: true,
		stdio: 'ignore',
	});
	child.unref();
}

export async function ensureDaemonRunning(): Promise<void> {
	try {
		await ping();
		return;
	} catch {
		try {
			await fs.unlink(getSocketPath());
		} catch {
			// ignore stale socket cleanup failures
		}
		spawnDaemon();
	}

	const deadline = Date.now() + 5000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await ping();
			return;
		} catch (error) {
			lastError = error;
			await new Promise(resolve => setTimeout(resolve, 150));
		}
	}
	throw new Error(`failed to start daemon: ${String(lastError)}`);
}

export async function listSessions(): Promise<SessionRecord[]> {
	await ensureDaemonRunning();
	return request<SessionRecord[]>({type: 'list', requestId: randomUUID()});
}

export async function createSession(input: CreateSessionInput): Promise<SessionRecord> {
	await ensureDaemonRunning();
	return request<SessionRecord>({type: 'create', requestId: randomUUID(), input});
}

export async function killSession(sessionId: string): Promise<void> {
	await ensureDaemonRunning();
	await request({type: 'kill', requestId: randomUUID(), sessionId});
}

export async function removeSession(sessionId: string): Promise<void> {
	await ensureDaemonRunning();
	await request({type: 'remove', requestId: randomUUID(), sessionId});
}

export async function openPersistentConnection(): Promise<net.Socket> {
	await ensureDaemonRunning();
	return createConnection();
}

interface LiveClientHandlers {
	onSessionUpdated?: (session: SessionRecord) => void;
	onSessionRemoved?: (sessionId: string) => void;
	onPreviewUpdated?: (preview: PreviewRecord) => void;
	onError?: (error: Error) => void;
	onClose?: () => void;
}

export class LiveClient {
	private readonly socket: net.Socket;
	private readonly handlers: LiveClientHandlers;
	private readonly pending = new Map<string, {resolve: (value: unknown) => void; reject: (error: Error) => void}>();
	private readonly stopParsing: () => void;
	private closed = false;

	constructor(socket: net.Socket, handlers: LiveClientHandlers = {}) {
		this.socket = socket;
		this.handlers = handlers;
		this.stopParsing = attachJsonParser(socket, message => {
			try {
				if (message.type === 'response') {
					const pending = this.pending.get(message.requestId);
					if (!pending) {
						return;
					}
					this.pending.delete(message.requestId);
					if (!message.ok) {
						pending.reject(new Error(message.error || 'daemon request failed'));
						return;
					}
					pending.resolve(message.data);
					return;
				}

				switch (message.type) {
					case 'session-updated':
						this.handlers.onSessionUpdated?.(message.session);
						return;
					case 'session-removed':
						this.handlers.onSessionRemoved?.(message.sessionId);
						return;
					case 'preview-updated':
						this.handlers.onPreviewUpdated?.(message.preview);
						return;
					default:
						return;
				}
			} catch (error) {
				this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		});

		socket.on('error', error => {
			this.rejectAll(error instanceof Error ? error : new Error(String(error)));
			this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
		});
		socket.on('close', () => {
			this.closed = true;
			this.stopParsing();
			this.rejectAll(new Error('daemon connection closed'));
			this.handlers.onClose?.();
		});
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}

	request<T>(message: Extract<ClientRequest, {requestId: string}>): Promise<T> {
		if (this.closed || this.socket.destroyed) {
			return Promise.reject(new Error('daemon connection is closed'));
		}
		return new Promise<T>((resolve, reject) => {
			this.pending.set(message.requestId, {
				resolve: value => resolve(value as T),
				reject,
			});
			writeMessage(this.socket, message);
		});
	}

	subscribe(repoRoot: string): Promise<SessionRecord[]> {
		return this.request<SessionRecord[]>({type: 'subscribe', requestId: randomUUID(), repoRoot});
	}

	watchPreview(sessionId: string | undefined, cols: number, rows: number): Promise<PreviewRecord> {
		return this.request<PreviewRecord>({
			type: 'watch-preview',
			requestId: randomUUID(),
			sessionId,
			cols,
			rows,
		});
	}

	listSessions(): Promise<SessionRecord[]> {
		return this.request<SessionRecord[]>({type: 'list', requestId: randomUUID()});
	}

	createSession(input: CreateSessionInput): Promise<SessionRecord> {
		return this.request<SessionRecord>({type: 'create', requestId: randomUUID(), input});
	}

	killSession(sessionId: string): Promise<void> {
		return this.request({type: 'kill', requestId: randomUUID(), sessionId});
	}

	removeSession(sessionId: string): Promise<void> {
		return this.request({type: 'remove', requestId: randomUUID(), sessionId});
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.stopParsing();
		this.rejectAll(new Error('daemon connection closed'));
		if (!this.socket.destroyed) {
			this.socket.end();
		}
	}
}

export async function createLiveClient(handlers: LiveClientHandlers = {}): Promise<LiveClient> {
	const socket = await openPersistentConnection();
	return new LiveClient(socket, handlers);
}

export {attachJsonParser, writeMessage};
