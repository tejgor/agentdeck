export type ProgramKey = 'claude' | 'pi';

export type SessionStatus = 'starting' | 'running' | 'exited';
export type AgentActivityStatus = 'unknown' | 'active' | 'idle';
export type WorktreeMode = 'none' | 'new' | 'existing';
export type SessionWorktreeMode = 'none' | 'managed' | 'attached';

export interface SessionWorktreeRecord {
	mode: SessionWorktreeMode;
	path?: string;
	branch?: string;
	head?: string;
	isMain?: boolean;
	origin?: 'created' | 'existing' | 'selected';
	creator?: 'script' | 'fallback' | 'picker';
	name?: string;
}

export interface WorktreeInfoRecord {
	path: string;
	branch: string;
	head: string;
	isMain: boolean;
}

export interface SessionRecord {
	id: string;
	title: string;
	program: ProgramKey;
	command: string;
	cwd: string;
	repoRoot: string;
	launchCwd?: string;
	launchWorktreeRoot?: string;
	worktree?: SessionWorktreeRecord;
	status: SessionStatus;
	agentStatus?: AgentActivityStatus;
	agentStatusUpdatedAt?: string;
	createdAt: string;
	updatedAt: string;
	pid?: number;
	exitCode?: number | null;
	exitSignal?: number | null;
	lastPreview?: string;
}

export interface PreviewRecord {
	sessionId?: string;
	content: string;
	live: boolean;
	status?: SessionStatus;
	agentStatus?: AgentActivityStatus;
}

export interface CreateSessionInput {
	title: string;
	program: ProgramKey;
	cwd: string;
	repoRoot: string;
	cols: number;
	rows: number;
	worktreeMode?: WorktreeMode;
	existingWorktreePath?: string;
}

export type ClientRequest =
	| {type: 'ping'; requestId: string}
	| {type: 'list'; requestId: string}
	| {type: 'subscribe'; requestId: string; repoRoot: string}
	| {type: 'list-worktrees'; requestId: string; cwd: string}
	| {type: 'watch-preview'; requestId: string; sessionId?: string; cols: number; rows: number}
	| {type: 'create'; requestId: string; input: CreateSessionInput}
	| {type: 'kill'; requestId: string; sessionId: string; deleteWorktree?: boolean}
	| {type: 'remove'; requestId: string; sessionId: string}
	| {type: 'attach'; requestId: string; sessionId: string}
	| {type: 'input'; sessionId: string; data: string}
	| {type: 'resize'; sessionId: string; cols: number; rows: number}
	| {type: 'detach'; sessionId: string};

export type ServerResponse<T = unknown> = {
	type: 'response';
	requestId: string;
	ok: boolean;
	data?: T;
	error?: string;
};

export type ServerEvent =
	| {type: 'output'; sessionId: string; data: string}
	| {type: 'session-updated'; session: SessionRecord}
	| {type: 'session-removed'; sessionId: string}
	| {type: 'preview-updated'; preview: PreviewRecord}
	| {type: 'attached'; sessionId: string}
	| {type: 'detached'; sessionId: string};

export type ServerMessage = ServerResponse | ServerEvent;

export type UiExitResult =
	| {kind: 'quit'}
	| {kind: 'attach'; sessionId: string};
