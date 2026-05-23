import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {getConfigDir, getConfigPath, getStatePath} from './paths.js';
import type {RemoteControlMode, SessionRecord} from './types.js';

interface InkState {
	sessions: SessionRecord[];
}

export interface AppConfig {
	dev_command?: string;
	attach_scroll_sensitivity?: number;
	remote_control?: RemoteControlConfig;
}

export interface RemoteControlConfig {
	enabled?: boolean;
	host?: string;
	port?: number;
	mode?: RemoteControlMode;
	tokenHash?: string;
}

const EMPTY_STATE: InkState = {sessions: []};

export async function ensureConfigDir(): Promise<void> {
	await fs.mkdir(getConfigDir(), {recursive: true, mode: 0o700});
	await fs.chmod(getConfigDir(), 0o700).catch(() => {});
}

export async function loadState(): Promise<InkState> {
	await ensureConfigDir();
	const statePath = getStatePath();
	try {
		const raw = await fs.readFile(statePath, 'utf8');
		if (!raw.trim()) {
			await saveState(EMPTY_STATE);
			return EMPTY_STATE;
		}
		const parsed = JSON.parse(raw) as Partial<InkState>;
		return {
			sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
		};
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') {
			await saveState(EMPTY_STATE);
			return EMPTY_STATE;
		}
		if (error instanceof SyntaxError) {
			const backupPath = `${statePath}.corrupt-${Date.now()}`;
			await fs.rename(statePath, backupPath).catch(() => {});
			await saveState(EMPTY_STATE);
			return EMPTY_STATE;
		}
		throw error;
	}
}

export async function saveState(state: InkState): Promise<void> {
	await ensureConfigDir();
	const statePath = getStatePath();
	const temporaryPath = `${statePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
	await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	await fs.rename(temporaryPath, statePath);
}

export async function saveSessions(sessions: SessionRecord[]): Promise<void> {
	await saveState({sessions});
}

// Daemon-crash/restart recovery: live PTYs are owned by the daemon process.
// If a new daemon process starts, any persisted non-exited sessions no longer
// have live node-pty handles and must be shown as exited. Normal frontend quit
// should not reach this path because the daemon should remain alive.
export async function markAllNonExitedSessionsExited(): Promise<SessionRecord[]> {
	const state = await loadState();
	let changed = false;
	const now = new Date().toISOString();
	const sessions = state.sessions.map(session => {
		if (session.status === 'exited') {
			if (session.devRunning) {
				changed = true;
				return {...session, devRunning: false};
			}
			return session;
		}
		changed = true;
		return {
			...session,
			status: 'exited' as const,
			updatedAt: now,
			pid: undefined,
			exitCode: session.exitCode ?? null,
			exitSignal: session.exitSignal ?? null,
			devRunning: false,
		};
	});
	if (changed) {
		await saveSessions(sessions);
	}
	return sessions;
}

export function sortSessionsNewestFirst(sessions: SessionRecord[]): SessionRecord[] {
	return [...sessions].sort((a, b) => {
		if (a.status !== b.status) {
			return a.status === 'running' ? -1 : 1;
		}
		return a.createdAt.localeCompare(b.createdAt);
	});
}

export async function loadAppConfig(): Promise<AppConfig> {
	await ensureConfigDir();
	try {
		const raw = await fs.readFile(getConfigPath(), 'utf8');
		const parsed = JSON.parse(raw) as Partial<AppConfig>;
		const remote = parsed.remote_control as Partial<RemoteControlConfig> | undefined;
		const remoteMode = remote?.mode === 'read-only' || remote?.mode === 'interactive' || remote?.mode === 'admin' ? remote.mode : undefined;
		return {
			dev_command: typeof parsed.dev_command === 'string' ? parsed.dev_command : undefined,
			attach_scroll_sensitivity: typeof parsed.attach_scroll_sensitivity === 'number' ? parsed.attach_scroll_sensitivity : undefined,
			remote_control: remote ? {
				enabled: remote.enabled === true,
				host: typeof remote.host === 'string' ? remote.host : undefined,
				port: typeof remote.port === 'number' ? remote.port : undefined,
				mode: remoteMode,
				tokenHash: typeof remote.tokenHash === 'string' ? remote.tokenHash : undefined,
			} : undefined,
		};
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') {
			return {};
		}
		throw error;
	}
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
	await ensureConfigDir();
	const configPath = getConfigPath();
	const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
	await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
	await fs.rename(temporaryPath, configPath);
	await fs.chmod(configPath, 0o600).catch(() => {});
}

export function stateFileDisplayPath(): string {
	return path.relative(process.cwd(), getStatePath()) || getStatePath();
}
