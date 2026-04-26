export type ProgramKey = 'claude' | 'pi';

export type SessionStatus = 'starting' | 'running' | 'exited';
export type AgentActivityStatus = 'unknown' | 'active' | 'idle';

export interface SessionRecord {
	id: string;
	title: string;
	program: ProgramKey;
	command: string;
	cwd: string;
	repoRoot: string;
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
}

export type ClientRequest =
	| {type: 'ping'; requestId: string}
	| {type: 'list'; requestId: string}
	| {type: 'subscribe'; requestId: string; repoRoot: string}
	| {type: 'watch-preview'; requestId: string; sessionId?: string; cols: number; rows: number}
	| {type: 'create'; requestId: string; input: CreateSessionInput}
	| {type: 'kill'; requestId: string; sessionId: string}
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
