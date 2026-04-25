import fs from 'node:fs/promises';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import pty, {type IPty} from 'node-pty';
import {getSocketPath} from './paths.js';
import {ensureNodePtyReady} from './nodePty.js';
import {ensureConfigDir, markAllNonExitedSessionsExited, saveSessions, sortSessionsNewestFirst} from './storage.js';
import {TerminalPreview} from './terminalPreview.js';
import type {ClientRequest, PreviewRecord, ServerMessage, ServerResponse, SessionRecord} from './types.js';

const execFileAsync = promisify(execFile);
const SCROLLBACK_LIMIT = 200_000;
const DEFAULT_PREVIEW_COLS = 80;
const DEFAULT_PREVIEW_ROWS = 24;
const PREVIEW_BROADCAST_DELAY_MS = 75;
const PROTOCOL_VERSION = 3;

interface RuntimeSession {
	term: IPty;
	scrollback: string;
	preview: TerminalPreview;
	attachedSocket?: net.Socket;
	previewBroadcastTimer?: NodeJS.Timeout;
}

interface ClientSubscription {
	repoRoot?: string;
	watchedPreviewSessionId?: string;
	previewCols: number;
	previewRows: number;
}

function sendMessage(socket: net.Socket, message: ServerMessage): void {
	if (!socket.destroyed) {
		socket.write(`${JSON.stringify(message)}\n`);
	}
}

function response<T>(requestId: string, data: T): ServerResponse<T> {
	return {type: 'response', requestId, ok: true, data};
}

function failure(requestId: string, error: unknown): ServerResponse {
	return {
		type: 'response',
		requestId,
		ok: false,
		error: error instanceof Error ? error.message : String(error),
	};
}

async function resolveProgramCommand(program: SessionRecord['program']): Promise<string> {
	const shell = process.env.SHELL || '/bin/bash';
	try {
		const {stdout} = await execFileAsync(shell, ['-ic', `command -v ${program}`]);
		const resolved = stdout.trim();
		return resolved || program;
	} catch {
		return program;
	}
}

function clampScrollback(value: string): string {
	return value.length <= SCROLLBACK_LIMIT ? value : value.slice(-SCROLLBACK_LIMIT);
}

function clampSize(value: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.floor(value));
}

export class InkDaemon {
	private readonly sessions = new Map<string, SessionRecord>();
	private readonly runtime = new Map<string, RuntimeSession>();
	private readonly clients = new Map<net.Socket, ClientSubscription>();
	private server?: net.Server;

	async start(): Promise<void> {
		await ensureConfigDir();
		await ensureNodePtyReady();
		const stored = await markAllNonExitedSessionsExited();
		for (const session of stored) {
			this.sessions.set(session.id, session);
		}

		await this.prepareSocket();
		await this.listen();
		this.setupProcessHandlers();
	}

	private async prepareSocket(): Promise<void> {
		try {
			await fs.unlink(getSocketPath());
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== 'ENOENT') {
				throw error;
			}
		}
	}

	private async listen(): Promise<void> {
		this.server = net.createServer(socket => this.handleConnection(socket));
		await new Promise<void>((resolve, reject) => {
			this.server?.once('error', reject);
			this.server?.listen(getSocketPath(), () => resolve());
		});
	}

	private setupProcessHandlers(): void {
		const shutdown = async () => {
			await this.cleanup();
			process.exit(0);
		};
		process.on('SIGINT', shutdown);
		process.on('SIGTERM', shutdown);
	}

	private async cleanup(): Promise<void> {
		for (const socket of this.clients.keys()) {
			socket.destroy();
		}
		this.clients.clear();

		for (const [sessionId, runtime] of this.runtime.entries()) {
			if (runtime.previewBroadcastTimer) {
				clearTimeout(runtime.previewBroadcastTimer);
			}
			const existing = this.sessions.get(sessionId);
			if (existing && existing.status !== 'exited') {
				this.sessions.set(sessionId, {
					...existing,
					lastPreview: runtime.preview.getSnapshot(),
				});
			}
			try {
				runtime.term.kill();
			} catch {
				// ignore shutdown errors
			}
			runtime.preview.dispose();
		}
		this.runtime.clear();
		await this.persist();

		if (this.server) {
			this.server.close();
		}
		try {
			await fs.unlink(getSocketPath());
		} catch {
			// ignore socket cleanup failures
		}
	}

	private handleConnection(socket: net.Socket): void {
		this.clients.set(socket, {
			previewCols: DEFAULT_PREVIEW_COLS,
			previewRows: DEFAULT_PREVIEW_ROWS,
		});

		let buffer = '';
		let attachedSessionId: string | undefined;

		const cleanup = () => {
			if (attachedSessionId) {
				const runtime = this.runtime.get(attachedSessionId);
				if (runtime?.attachedSocket === socket) {
					runtime.attachedSocket = undefined;
				}
				attachedSessionId = undefined;
			}
			this.clients.delete(socket);
		};

		socket.on('data', chunk => {
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
				const message = JSON.parse(line) as ClientRequest;
				void this.handleRequest(socket, message, sessionId => {
					attachedSessionId = sessionId;
				});
			}
		});

		socket.on('close', cleanup);
		socket.on('error', cleanup);
	}

	private getClient(socket: net.Socket): ClientSubscription {
		const client = this.clients.get(socket);
		if (!client) {
			const created: ClientSubscription = {
				previewCols: DEFAULT_PREVIEW_COLS,
				previewRows: DEFAULT_PREVIEW_ROWS,
			};
			this.clients.set(socket, created);
			return created;
		}
		return client;
	}

	private async handleRequest(
		socket: net.Socket,
		message: ClientRequest,
		setAttachedSessionId: (sessionId: string | undefined) => void,
	): Promise<void> {
		try {
			switch (message.type) {
				case 'ping':
					sendMessage(socket, response(message.requestId, {ok: true, version: PROTOCOL_VERSION}));
					return;
				case 'list':
					sendMessage(socket, response(message.requestId, sortSessionsNewestFirst([...this.sessions.values()])));
					return;
				case 'subscribe': {
					const client = this.getClient(socket);
					client.repoRoot = message.repoRoot;
					sendMessage(socket, response(message.requestId, this.sessionsForRepo(message.repoRoot)));
					return;
				}
				case 'watch-preview': {
					const client = this.getClient(socket);
					client.watchedPreviewSessionId = message.sessionId;
					client.previewCols = clampSize(message.cols, client.previewCols);
					client.previewRows = clampSize(message.rows, client.previewRows);
					const preview = await this.getPreviewRecord(message.sessionId, client.previewCols, client.previewRows);
					sendMessage(socket, response(message.requestId, preview));
					return;
				}
				case 'create': {
					const session = await this.createSession(message.input);
					sendMessage(socket, response(message.requestId, session));
					return;
				}
				case 'kill':
					await this.killSession(message.sessionId);
					sendMessage(socket, response(message.requestId, {ok: true}));
					return;
				case 'remove':
					await this.removeSession(message.sessionId);
					sendMessage(socket, response(message.requestId, {ok: true}));
					return;
				case 'attach': {
					const session = this.sessions.get(message.sessionId);
					const runtime = this.runtime.get(message.sessionId);
					if (!session || !runtime) {
						throw new Error('session is not running');
					}
					if (runtime.attachedSocket && runtime.attachedSocket !== socket && !runtime.attachedSocket.destroyed) {
						throw new Error('session is already attached elsewhere');
					}
					runtime.attachedSocket = socket;
					setAttachedSessionId(session.id);
					sendMessage(socket, response(message.requestId, session));
					sendMessage(socket, {type: 'attached', sessionId: session.id});
					if (runtime.scrollback) {
						sendMessage(socket, {type: 'output', sessionId: session.id, data: runtime.scrollback});
					}
					return;
				}
				case 'input': {
					const runtime = this.runtime.get(message.sessionId);
					if (runtime) {
						runtime.term.write(message.data);
					}
					return;
				}
				case 'resize': {
					const runtime = this.runtime.get(message.sessionId);
					if (runtime) {
						const cols = Math.max(1, message.cols);
						const rows = Math.max(1, message.rows);
						runtime.term.resize(cols, rows);
						await runtime.preview.resize(cols, rows);
						this.schedulePreviewBroadcast(message.sessionId);
					}
					return;
				}
				case 'detach': {
					const runtime = this.runtime.get(message.sessionId);
					if (runtime?.attachedSocket === socket) {
						runtime.attachedSocket = undefined;
					}
					setAttachedSessionId(undefined);
					sendMessage(socket, {type: 'detached', sessionId: message.sessionId});
					return;
				}
			}
		} catch (error) {
			if ('requestId' in message) {
				sendMessage(socket, failure(message.requestId, error));
			}
		}
	}

	private sessionsForRepo(repoRoot: string): SessionRecord[] {
		return sortSessionsNewestFirst([...this.sessions.values()].filter(session => session.repoRoot === repoRoot));
	}

	private broadcastSessionUpdated(session: SessionRecord): void {
		for (const [socket, client] of this.clients.entries()) {
			if (client.repoRoot === session.repoRoot) {
				sendMessage(socket, {type: 'session-updated', session});
			}
		}
	}

	private broadcastSessionRemoved(sessionId: string, repoRoot: string): void {
		for (const [socket, client] of this.clients.entries()) {
			if (client.repoRoot === repoRoot) {
				sendMessage(socket, {type: 'session-removed', sessionId});
			}
		}
	}

	private schedulePreviewBroadcast(sessionId: string): void {
		const runtime = this.runtime.get(sessionId);
		if (!runtime || runtime.previewBroadcastTimer) {
			return;
		}
		runtime.previewBroadcastTimer = setTimeout(() => {
			runtime.previewBroadcastTimer = undefined;
			this.broadcastPreview(sessionId);
		}, PREVIEW_BROADCAST_DELAY_MS);
	}

	private broadcastPreview(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		for (const [socket, client] of this.clients.entries()) {
			if (client.watchedPreviewSessionId !== sessionId) {
				continue;
			}
			const preview = this.buildPreviewRecord(session, this.runtime.get(sessionId)?.preview.getSnapshot() ?? session.lastPreview ?? '');
			sendMessage(socket, {type: 'preview-updated', preview});
		}
	}

	private buildPreviewRecord(session: SessionRecord, content: string): PreviewRecord {
		return {
			sessionId: session.id,
			content,
			live: session.status === 'running',
			status: session.status,
		};
	}

	private async getPreviewRecord(sessionId: string | undefined, cols: number, rows: number): Promise<PreviewRecord> {
		if (!sessionId) {
			return {
				content: '',
				live: false,
			};
		}

		const session = this.sessions.get(sessionId);
		if (!session) {
			return {
				sessionId,
				content: '',
				live: false,
			};
		}

		const runtime = this.runtime.get(sessionId);
		if (runtime) {
			runtime.term.resize(cols, rows);
			await runtime.preview.resize(cols, rows);
			return this.buildPreviewRecord(session, runtime.preview.getSnapshot());
		}

		return this.buildPreviewRecord(session, session.lastPreview ?? '');
	}

	private async createSession(input: {
		title: string;
		program: SessionRecord['program'];
		cwd: string;
		repoRoot: string;
		cols: number;
		rows: number;
	}): Promise<SessionRecord> {
		const title = input.title.trim();
		if (!title) {
			throw new Error('title cannot be empty');
		}
		if (title.length > 64) {
			throw new Error('title cannot be longer than 64 characters');
		}
		const conflict = [...this.sessions.values()].find(
			session => session.repoRoot === input.repoRoot && session.title === title && session.status !== 'exited',
		);
		if (conflict) {
			throw new Error(`an active session named "${title}" already exists in this repo`);
		}

		const command = await resolveProgramCommand(input.program);
		const now = new Date().toISOString();
		const baseSession: SessionRecord = {
			id: randomUUID(),
			title,
			program: input.program,
			command,
			cwd: input.cwd,
			repoRoot: input.repoRoot,
			status: 'starting',
			createdAt: now,
			updatedAt: now,
			lastPreview: '',
		};
		this.sessions.set(baseSession.id, baseSession);
		await this.persist();
		this.broadcastSessionUpdated(baseSession);

		let term: IPty;
		try {
			term = pty.spawn(command, [], {
				name: 'xterm-256color',
				cwd: input.cwd,
				env: {...process.env},
				cols: Math.max(1, input.cols),
				rows: Math.max(1, input.rows),
			});
		} catch (error) {
			this.sessions.delete(baseSession.id);
			await this.persist();
			this.broadcastSessionRemoved(baseSession.id, baseSession.repoRoot);
			throw error;
		}

		const runningSession: SessionRecord = {
			...baseSession,
			status: 'running',
			updatedAt: new Date().toISOString(),
			pid: term.pid,
		};
		this.sessions.set(baseSession.id, runningSession);

		const runtime: RuntimeSession = {
			term,
			scrollback: '',
			preview: new TerminalPreview(input.cols, input.rows),
		};
		this.runtime.set(baseSession.id, runtime);

		term.onData(output => {
			runtime.scrollback = clampScrollback(runtime.scrollback + output);
			void runtime.preview.write(output).then(() => {
				this.schedulePreviewBroadcast(baseSession.id);
			});
			if (runtime.attachedSocket && !runtime.attachedSocket.destroyed) {
				sendMessage(runtime.attachedSocket, {type: 'output', sessionId: baseSession.id, data: output});
			}
		});

		term.onExit(({exitCode, signal}) => {
			this.handleSessionExit(baseSession.id, exitCode ?? null, signal ?? null);
		});

		await this.persist();
		this.broadcastSessionUpdated(runningSession);
		this.schedulePreviewBroadcast(runningSession.id);
		return runningSession;
	}

	private async killSession(sessionId: string): Promise<void> {
		const runtime = this.runtime.get(sessionId);
		if (!runtime) {
			throw new Error('session is not running');
		}
		runtime.term.kill();
	}

	private async removeSession(sessionId: string): Promise<void> {
		const existing = this.sessions.get(sessionId);
		if (!existing) {
			throw new Error('session does not exist');
		}
		if (this.runtime.has(sessionId) || existing.status === 'running') {
			throw new Error('kill the session before removing it');
		}
		this.sessions.delete(sessionId);
		await this.persist();
		this.broadcastSessionRemoved(sessionId, existing.repoRoot);
	}

	private handleSessionExit(sessionId: string, exitCode: number | null, exitSignal: number | null): void {
		const existing = this.sessions.get(sessionId);
		if (!existing || existing.status === 'exited') {
			return;
		}
		const runtime = this.runtime.get(sessionId);
		this.runtime.delete(sessionId);
		if (runtime?.previewBroadcastTimer) {
			clearTimeout(runtime.previewBroadcastTimer);
		}
		const updated: SessionRecord = {
			...existing,
			status: 'exited',
			updatedAt: new Date().toISOString(),
			exitCode,
			exitSignal,
			lastPreview: runtime?.preview.getSnapshot() ?? existing.lastPreview,
		};
		this.sessions.set(sessionId, updated);
		void this.persist();
		runtime?.preview.dispose();
		this.broadcastSessionUpdated(updated);
		for (const [socket, client] of this.clients.entries()) {
			if (client.watchedPreviewSessionId === sessionId) {
				sendMessage(socket, {type: 'preview-updated', preview: this.buildPreviewRecord(updated, updated.lastPreview ?? '')});
			}
		}
		if (runtime?.attachedSocket && !runtime.attachedSocket.destroyed) {
			sendMessage(runtime.attachedSocket, {type: 'session-updated', session: updated});
		}
	}

	private async persist(): Promise<void> {
		await saveSessions(sortSessionsNewestFirst([...this.sessions.values()]));
	}
}
