import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import pty, {type IPty} from 'node-pty';
import {getDaemonLogPath, getDaemonPidPath, getSocketPath} from './paths.js';
import {createWorktreeForSession, findRepoRoot, listWorktrees, removeWorktree} from './git.js';
import {ensureNodePtyReady} from './nodePty.js';
import {ensureConfigDir, markAllNonExitedSessionsExited, saveSessions, sortSessionsNewestFirst} from './storage.js';
import {TerminalPreview} from './terminalPreview.js';
import type {AgentActivityStatus, ClientRequest, CreateSessionInput, PreviewRecord, ServerMessage, ServerResponse, SessionRecord} from './types.js';

const execFileAsync = promisify(execFile);
const SCROLLBACK_LIMIT = 200_000;
const DEFAULT_PREVIEW_COLS = 80;
const DEFAULT_PREVIEW_ROWS = 24;
const PREVIEW_BROADCAST_DELAY_MS = 75;
const ACTIVITY_EVALUATION_DELAY_MS = 150;
const ACTIVITY_WINDOW_MS = 3000;
const IDLE_AFTER_MS = 5000;
const ACTIVE_MIN_CHANGED_CHARS = 1;
const RESIZE_ACTIVITY_SUPPRESSION_MS = 750;
const PROTOCOL_VERSION = 8;

interface RuntimeSession {
	term: IPty;
	scrollback: string;
	preview: TerminalPreview;
	attachedSocket?: net.Socket;
	previewBroadcastTimer?: NodeJS.Timeout;
	activityEvaluationTimer?: NodeJS.Timeout;
	activityIdleTimer?: NodeJS.Timeout;
	suppressActivityUntil?: number;
	lastPreviewSnapshot: string;
	previewChangeEvents: Array<{at: number; changedChars: number}>;
	deleteWorktreeOnExit?: boolean;
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
	private shuttingDown = false;

	async start(): Promise<void> {
		await ensureConfigDir();
		await this.log(`starting daemon pid=${process.pid}`);
		await this.assertNoLiveDaemonFromPidFile();
		await ensureNodePtyReady();
		// If this daemon is starting, any previously-running sessions belonged to a
		// different daemon process and their node-pty handles are gone. Mark them
		// exited as crash/restart recovery, not as normal frontend quit behavior.
		const stored = await markAllNonExitedSessionsExited();
		for (const session of stored) {
			this.sessions.set(session.id, session);
		}

		await this.prepareSocket();
		await this.listen();
		await this.writePidFile();
		this.setupProcessHandlers();
		await this.log(`daemon ready socket=${getSocketPath()}`);
	}

	private async log(message: string): Promise<void> {
		try {
			await fs.appendFile(getDaemonLogPath(), `[${new Date().toISOString()}] daemon ${message}\n`, 'utf8');
		} catch {
			// Logging must never keep the daemon from starting or shutting down.
		}
	}

	private isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private async assertNoLiveDaemonFromPidFile(): Promise<void> {
		try {
			const raw = await fs.readFile(getDaemonPidPath(), 'utf8');
			const pid = Number.parseInt(raw.trim(), 10);
			if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && this.isProcessAlive(pid)) {
				throw new Error(`daemon already appears to be running as pid ${pid}`);
			}
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === 'ENOENT') {
				return;
			}
			throw error;
		}
	}

	private async writePidFile(): Promise<void> {
		await fs.writeFile(getDaemonPidPath(), `${process.pid}\n`, 'utf8');
	}

	private async removePidFile(): Promise<void> {
		try {
			const raw = await fs.readFile(getDaemonPidPath(), 'utf8');
			if (Number.parseInt(raw.trim(), 10) !== process.pid) {
				return;
			}
			await fs.unlink(getDaemonPidPath());
		} catch {
			// ignore pid cleanup failures
		}
	}

	private async prepareSocket(): Promise<void> {
		try {
			await fs.unlink(getSocketPath());
			await this.log('removed stale socket before listen');
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
		const shutdown = async (signal: NodeJS.Signals) => {
			try {
				await this.log(`received ${signal}; shutting down`);
				await this.cleanup();
			} finally {
				process.exit(0);
			}
		};
		process.on('SIGINT', () => void shutdown('SIGINT'));
		process.on('SIGTERM', () => void shutdown('SIGTERM'));
		process.on('SIGHUP', () => {
			void this.log('received SIGHUP; keeping daemon alive');
		});
		process.on('uncaughtException', error => {
			void (async () => {
				try {
					await this.log(`uncaught exception: ${error.stack || error.message}`);
					await this.cleanup();
				} finally {
					process.exit(1);
				}
			})();
		});
		process.on('unhandledRejection', reason => {
			void (async () => {
				try {
					await this.log(`unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
					await this.cleanup();
				} finally {
					process.exit(1);
				}
			})();
		});
	}

	private async cleanup(): Promise<void> {
		if (this.shuttingDown) {
			return;
		}
		this.shuttingDown = true;
		await this.log('cleanup start');
		for (const socket of this.clients.keys()) {
			socket.destroy();
		}
		this.clients.clear();

		for (const [sessionId, runtime] of this.runtime.entries()) {
			this.clearRuntimeActivityTimers(runtime);
			if (runtime.previewBroadcastTimer) {
				clearTimeout(runtime.previewBroadcastTimer);
			}
			const existing = this.sessions.get(sessionId);
			if (existing && existing.status !== 'exited') {
				this.sessions.set(sessionId, {
					...existing,
					lastPreview: await runtime.preview.getSnapshot(),
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
		await this.removePidFile();
		await this.log('cleanup complete');
	}

	private handleConnection(socket: net.Socket): void {
		void this.log('client connected');
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
			void this.log('client disconnected');
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
				case 'list-worktrees': {
					sendMessage(socket, response(message.requestId, await listWorktrees(message.cwd)));
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
				case 'restart': {
					const session = await this.restartSession(message.sessionId, message.cols, message.rows);
					sendMessage(socket, response(message.requestId, session));
					return;
				}
				case 'kill':
					await this.killSession(message.sessionId, message.deleteWorktree ?? false);
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
						await this.suppressResizeActivity(runtime);
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
			void this.broadcastPreview(sessionId);
		}, PREVIEW_BROADCAST_DELAY_MS);
	}

	private clearRuntimeActivityTimers(runtime: RuntimeSession): void {
		if (runtime.activityEvaluationTimer) {
			clearTimeout(runtime.activityEvaluationTimer);
			runtime.activityEvaluationTimer = undefined;
		}
		if (runtime.activityIdleTimer) {
			clearTimeout(runtime.activityIdleTimer);
			runtime.activityIdleTimer = undefined;
		}
	}

	private changedCharacterCount(previous: string, next: string): number {
		const maxLength = Math.max(previous.length, next.length);
		let changed = Math.abs(previous.length - next.length);
		const sharedLength = Math.min(previous.length, next.length);
		for (let index = 0; index < sharedLength; index += 1) {
			if (previous[index] !== next[index]) {
				changed += 1;
			}
		}
		return Math.min(changed, maxLength);
	}

	private scheduleActivityEvaluation(sessionId: string): void {
		const runtime = this.runtime.get(sessionId);
		if (!runtime || runtime.activityEvaluationTimer || Date.now() < (runtime.suppressActivityUntil ?? 0)) {
			return;
		}
		runtime.activityEvaluationTimer = setTimeout(() => {
			runtime.activityEvaluationTimer = undefined;
			void this.evaluatePreviewActivity(sessionId);
		}, ACTIVITY_EVALUATION_DELAY_MS);
	}

	private async evaluatePreviewActivity(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		const runtime = this.runtime.get(sessionId);
		if (!session || !runtime || session.status !== 'running' || Date.now() < (runtime.suppressActivityUntil ?? 0)) {
			return;
		}

		const snapshot = await runtime.preview.getSnapshot();
		const changedChars = this.changedCharacterCount(runtime.lastPreviewSnapshot, snapshot);
		runtime.lastPreviewSnapshot = snapshot;
		if (changedChars < ACTIVE_MIN_CHANGED_CHARS) {
			return;
		}

		const now = Date.now();
		runtime.previewChangeEvents = runtime.previewChangeEvents
			.filter(event => now - event.at <= ACTIVITY_WINDOW_MS)
			.concat({at: now, changedChars});
		const recentChangedChars = runtime.previewChangeEvents.reduce((total, event) => total + event.changedChars, 0);
		if (recentChangedChars >= ACTIVE_MIN_CHANGED_CHARS) {
			await this.setAgentStatus(sessionId, 'active');
		}

		if (runtime.activityIdleTimer) {
			clearTimeout(runtime.activityIdleTimer);
		}
		runtime.activityIdleTimer = setTimeout(() => {
			runtime.activityIdleTimer = undefined;
			runtime.previewChangeEvents = [];
			void this.setAgentStatus(sessionId, 'idle');
		}, IDLE_AFTER_MS);
	}

	private async suppressResizeActivity(runtime: RuntimeSession): Promise<void> {
		runtime.suppressActivityUntil = Date.now() + RESIZE_ACTIVITY_SUPPRESSION_MS;
		runtime.lastPreviewSnapshot = await runtime.preview.getSnapshot();
	}

	private async setAgentStatus(sessionId: string, agentStatus: AgentActivityStatus): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session || session.status === 'exited' || session.agentStatus === agentStatus) {
			return;
		}
		const updated: SessionRecord = {
			...session,
			agentStatus,
			agentStatusUpdatedAt: new Date().toISOString(),
			updatedAt: session.updatedAt,
		};
		this.sessions.set(sessionId, updated);
		await this.persist();
		this.broadcastSessionUpdated(updated);
		await this.broadcastPreview(sessionId);
	}

	private async broadcastPreview(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		const runtime = this.runtime.get(sessionId);
		const snapshot = runtime ? await runtime.preview.getSnapshot() : session.lastPreview ?? '';
		for (const [socket, client] of this.clients.entries()) {
			if (client.watchedPreviewSessionId !== sessionId) {
				continue;
			}
			const preview = this.buildPreviewRecord(session, snapshot);
			sendMessage(socket, {type: 'preview-updated', preview});
		}
	}

	private buildPreviewRecord(session: SessionRecord, content: string): PreviewRecord {
		return {
			sessionId: session.id,
			content,
			live: session.status === 'running',
			status: session.status,
			agentStatus: session.agentStatus,
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
			await this.suppressResizeActivity(runtime);
			return this.buildPreviewRecord(session, await runtime.preview.getSnapshot());
		}

		return this.buildPreviewRecord(session, session.lastPreview ?? '');
	}

	private async createSession(input: CreateSessionInput): Promise<SessionRecord> {
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
		const launchCwd = input.cwd;
		const launchWorktreeRoot = await findRepoRoot(launchCwd);
		let sessionCwd = launchCwd;
		let worktree: SessionRecord['worktree'] = {mode: 'none'};
		const requestedWorktreeMode = input.worktreeMode ?? 'none';
		if (requestedWorktreeMode === 'new') {
			const created = await createWorktreeForSession(title, launchCwd);
			sessionCwd = created.path;
			worktree = {
				mode: created.origin === 'created' ? 'managed' : 'attached',
				path: created.path,
				branch: created.branch,
				head: created.head,
				isMain: created.isMain,
				origin: created.origin,
				creator: created.creator,
				name: created.name,
			};
		} else if (requestedWorktreeMode === 'existing') {
			if (!input.existingWorktreePath) {
				throw new Error('existing worktree path is required');
			}
			const selectedPath = input.existingWorktreePath;
			const worktrees = await listWorktrees(launchCwd);
			const selected = worktrees.find(item => item.path === selectedPath);
			if (!selected) {
				throw new Error(`selected path is not a git worktree: ${selectedPath}`);
			}
			sessionCwd = selected.path;
			worktree = {
				mode: 'attached',
				path: selected.path,
				branch: selected.branch,
				head: selected.head,
				isMain: selected.isMain,
				origin: 'selected',
				creator: 'picker',
				name: selected.branch || selected.path.split('/').at(-1),
			};
		}
		const now = new Date().toISOString();
		const baseSession: SessionRecord = {
			id: randomUUID(),
			title,
			program: input.program,
			command,
			cwd: sessionCwd,
			repoRoot: input.repoRoot,
			launchCwd,
			launchWorktreeRoot,
			worktree,
			status: 'starting',
			agentStatus: 'unknown',
			agentStatusUpdatedAt: now,
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
				cwd: sessionCwd,
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
			lastPreviewSnapshot: '',
			previewChangeEvents: [],
		};
		this.runtime.set(baseSession.id, runtime);
		runtime.activityIdleTimer = setTimeout(() => {
			runtime.activityIdleTimer = undefined;
			void this.setAgentStatus(baseSession.id, 'idle');
		}, IDLE_AFTER_MS);

		term.onData(output => {
			runtime.scrollback = clampScrollback(runtime.scrollback + output);
			void runtime.preview.write(output);
			this.scheduleActivityEvaluation(baseSession.id);
			this.schedulePreviewBroadcast(baseSession.id);
			if (runtime.attachedSocket && !runtime.attachedSocket.destroyed) {
				sendMessage(runtime.attachedSocket, {type: 'output', sessionId: baseSession.id, data: output});
			}
		});

		term.onExit(({exitCode, signal}) => {
			void this.handleSessionExit(baseSession.id, exitCode ?? null, signal ?? null);
		});

		await this.persist();
		this.broadcastSessionUpdated(runningSession);
		this.schedulePreviewBroadcast(runningSession.id);
		return runningSession;
	}

	private async restartSession(sessionId: string, cols: number, rows: number): Promise<SessionRecord> {
		const existing = this.sessions.get(sessionId);
		if (!existing) {
			throw new Error('session does not exist');
		}
		if (this.runtime.has(sessionId) || existing.status !== 'exited') {
			throw new Error('session is already running');
		}

		const now = new Date().toISOString();
		const starting: SessionRecord = {
			...existing,
			status: 'starting',
			agentStatus: 'unknown',
			agentStatusUpdatedAt: now,
			updatedAt: now,
			exitCode: undefined,
			exitSignal: undefined,
			lastPreview: '',
		};
		this.sessions.set(sessionId, starting);
		await this.persist();
		this.broadcastSessionUpdated(starting);

		let term: IPty;
		try {
			term = pty.spawn(starting.command, [], {
				name: 'xterm-256color',
				cwd: starting.cwd,
				env: {...process.env},
				cols: Math.max(1, cols),
				rows: Math.max(1, rows),
			});
		} catch (error) {
			this.sessions.set(sessionId, existing);
			await this.persist();
			this.broadcastSessionUpdated(existing);
			throw error;
		}

		const runningSession: SessionRecord = {
			...starting,
			status: 'running',
			updatedAt: new Date().toISOString(),
			pid: term.pid,
		};
		this.sessions.set(sessionId, runningSession);

		const runtime: RuntimeSession = {
			term,
			scrollback: '',
			preview: new TerminalPreview(cols, rows),
			lastPreviewSnapshot: '',
			previewChangeEvents: [],
		};
		this.runtime.set(sessionId, runtime);
		runtime.activityIdleTimer = setTimeout(() => {
			runtime.activityIdleTimer = undefined;
			void this.setAgentStatus(sessionId, 'idle');
		}, IDLE_AFTER_MS);

		term.onData(output => {
			runtime.scrollback = clampScrollback(runtime.scrollback + output);
			void runtime.preview.write(output);
			this.scheduleActivityEvaluation(sessionId);
			this.schedulePreviewBroadcast(sessionId);
			if (runtime.attachedSocket && !runtime.attachedSocket.destroyed) {
				sendMessage(runtime.attachedSocket, {type: 'output', sessionId, data: output});
			}
		});

		term.onExit(({exitCode, signal}) => {
			void this.handleSessionExit(sessionId, exitCode ?? null, signal ?? null);
		});

		await this.persist();
		this.broadcastSessionUpdated(runningSession);
		this.schedulePreviewBroadcast(sessionId);
		return runningSession;
	}

	private canDeleteSessionWorktree(session: SessionRecord): {ok: true} | {ok: false; reason: string} {
		const worktree = session.worktree;
		const worktreePath = worktree?.path;
		if (!worktreePath || !worktree || worktree.mode === 'none') {
			return {ok: false, reason: 'session does not have a worktree'};
		}
		if (worktree.isMain) {
			return {ok: false, reason: 'cannot delete the main worktree'};
		}
		if (session.launchWorktreeRoot && path.resolve(worktreePath) === path.resolve(session.launchWorktreeRoot)) {
			return {ok: false, reason: 'cannot delete the current worktree'};
		}
		const other = [...this.sessions.values()].find(candidate => {
			const candidatePath = candidate.worktree?.path;
			return (
				candidate.id !== session.id &&
				candidate.status !== 'exited' &&
				Boolean(candidatePath) &&
				path.resolve(candidatePath!) === path.resolve(worktreePath)
			);
		});
		if (other) {
			return {ok: false, reason: `worktree is in use by session "${other.title}"`};
		}
		return {ok: true};
	}

	private async killSession(sessionId: string, deleteWorktree: boolean): Promise<void> {
		const session = this.sessions.get(sessionId);
		const runtime = this.runtime.get(sessionId);
		if (!session || !runtime) {
			throw new Error('session is not running');
		}
		if (deleteWorktree) {
			const allowed = this.canDeleteSessionWorktree(session);
			if (!allowed.ok) {
				throw new Error(allowed.reason);
			}
			runtime.deleteWorktreeOnExit = true;
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

	private async handleSessionExit(sessionId: string, exitCode: number | null, exitSignal: number | null): Promise<void> {
		const existing = this.sessions.get(sessionId);
		if (!existing || existing.status === 'exited') {
			return;
		}
		const runtime = this.runtime.get(sessionId);
		this.runtime.delete(sessionId);
		if (runtime) {
			this.clearRuntimeActivityTimers(runtime);
		}
		if (runtime?.previewBroadcastTimer) {
			clearTimeout(runtime.previewBroadcastTimer);
		}
		const now = new Date().toISOString();
		const updated: SessionRecord = {
			...existing,
			status: 'exited',
			agentStatus: 'idle',
			agentStatusUpdatedAt: now,
			updatedAt: now,
			exitCode,
			exitSignal,
			lastPreview: runtime ? await runtime.preview.getSnapshot() : existing.lastPreview,
		};
		this.sessions.set(sessionId, updated);
		if (runtime?.deleteWorktreeOnExit && existing.worktree?.path) {
			try {
				await removeWorktree(existing.worktree.path, existing.launchWorktreeRoot ?? existing.repoRoot);
			} catch (error) {
				await this.log(`failed to remove worktree for session ${existing.title}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
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
