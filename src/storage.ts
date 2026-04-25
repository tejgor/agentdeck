import fs from 'node:fs/promises';
import path from 'node:path';
import {getConfigDir, getStatePath} from './paths.js';
import type {SessionRecord} from './types.js';

interface InkState {
	sessions: SessionRecord[];
}

const EMPTY_STATE: InkState = {sessions: []};

export async function ensureConfigDir(): Promise<void> {
	await fs.mkdir(getConfigDir(), {recursive: true});
}

export async function loadState(): Promise<InkState> {
	await ensureConfigDir();
	const statePath = getStatePath();
	try {
		const raw = await fs.readFile(statePath, 'utf8');
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
		throw error;
	}
}

export async function saveState(state: InkState): Promise<void> {
	await ensureConfigDir();
	const statePath = getStatePath();
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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
			return session;
		}
		changed = true;
		return {
			...session,
			status: 'exited' as const,
			updatedAt: now,
			exitCode: session.exitCode ?? null,
			exitSignal: session.exitSignal ?? null,
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
		return b.createdAt.localeCompare(a.createdAt);
	});
}

export function stateFileDisplayPath(): string {
	return path.relative(process.cwd(), getStatePath()) || getStatePath();
}
