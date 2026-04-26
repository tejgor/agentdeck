import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {LiveClient, createLiveClient} from './client.js';
import {PreviewPane} from './preview.js';
import {Sidebar} from './sidebar.js';
import type {PreviewRecord, ProgramKey, SessionRecord, UiExitResult, WorktreeInfoRecord, WorktreeMode} from './types.js';

const PROGRAMS: Array<{key: ProgramKey; label: string; glyph: string}> = [
	{key: 'claude', label: 'Claude', glyph: '✶'},
	{key: 'pi', label: 'Pi', glyph: 'π'},
];

const EMPTY_PREVIEW: PreviewRecord = {
	content: '',
	live: false,
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const WORKTREE_MODES: Array<{key: WorktreeMode; label: string}> = [
	{key: 'none', label: 'no worktree'},
	{key: 'new', label: 'new worktree'},
	{key: 'existing', label: 'existing worktree'},
];

type Mode = 'browse' | 'pick-program' | 'enter-name' | 'pick-worktree' | 'confirm-kill';

interface AppProps {
	repoRoot: string;
	cwd: string;
	initialSidebarWidth?: number;
	onSidebarWidthChange?: (width: number) => void;
}

interface TerminalSize {
	cols: number;
	rows: number;
}

function getTerminalSize(): TerminalSize {
	return {
		cols: process.stdout.columns || 80,
		rows: process.stdout.rows || 24,
	};
}

function sidebarWidth(totalWidth: number): number {
	if (totalWidth <= 0) {
		return 24;
	}
	let width = Math.floor(totalWidth * 0.24);
	width = Math.max(24, Math.min(34, width));
	return clampSidebarWidth(width, totalWidth);
}

function clampSidebarWidth(width: number, totalWidth: number): number {
	const minWidth = Math.min(18, Math.max(10, totalWidth - 23));
	const maxWidth = Math.max(minWidth, Math.min(Math.floor(totalWidth * 0.5), totalWidth - 23));
	return Math.max(minWidth, Math.min(maxWidth, Math.floor(width)));
}

function sortSessions(sessions: SessionRecord[]): SessionRecord[] {
	return [...sessions].sort((a, b) => {
		if (a.status !== b.status) {
			if (a.status === 'running') {
				return -1;
			}
			if (b.status === 'running') {
				return 1;
			}
			if (a.status === 'starting') {
				return -1;
			}
			if (b.status === 'starting') {
				return 1;
			}
		}
		return b.createdAt.localeCompare(a.createdAt);
	});
}

function upsertSession(existing: SessionRecord[], session: SessionRecord): SessionRecord[] {
	const next = existing.filter(item => item.id !== session.id);
	next.push(session);
	return sortSessions(next);
}

function describeConnection(client: LiveClient | undefined): string {
	return client ? 'connected' : 'connecting…';
}

function CreatePane({
	mode,
	programIndex,
	draftName,
	worktreeMode,
	width,
}: {
	mode: 'pick-program' | 'enter-name';
	programIndex: number;
	draftName: string;
	worktreeMode: WorktreeMode;
	width: number;
}) {
	return (
		<Box flexDirection="column" width={width}>
			<Text bold>
				{mode === 'pick-program'
					? 'Create session'
					: `Create ${PROGRAMS[programIndex]!.glyph} ${PROGRAMS[programIndex]!.label} session`}
			</Text>
			{mode === 'pick-program' ? (
				<>
					<Text>Select agent:</Text>
					{PROGRAMS.map((program, index) => (
						<Text key={program.key} inverse={index === programIndex}>
							{index === programIndex ? '›' : ' '} {program.glyph} {program.label}
						</Text>
					))}
					<Text dimColor>enter continue • esc cancel • arrows switch</Text>
				</>
			) : (
				<>
					<Text>Name: {draftName || '█'}</Text>
					<Text>Worktree: {WORKTREE_MODES.find(item => item.key === worktreeMode)?.label}</Text>
					<Text dimColor>tab cycle worktree • enter create • esc back • backspace delete</Text>
				</>
			)}
		</Box>
	);
}

function worktreeLabel(worktree: WorktreeInfoRecord): string {
	const branch = worktree.branch || '(detached)';
	return `${worktree.isMain ? 'main ' : ''}${branch}  ${worktree.path}`;
}

function WorktreePickerPane({worktrees, selectedIndex, width}: {worktrees: WorktreeInfoRecord[]; selectedIndex: number; width: number}) {
	return (
		<Box flexDirection="column" width={width}>
			<Text bold>Select existing worktree</Text>
			{worktrees.length === 0 ? <Text dimColor>No worktrees found.</Text> : null}
			{worktrees.map((worktree, index) => (
				<Text key={worktree.path} inverse={index === selectedIndex}>
					{index === selectedIndex ? '›' : ' '} {worktreeLabel(worktree)}
				</Text>
			))}
			<Text dimColor>enter select • esc back • j/k move</Text>
		</Box>
	);
}

function KillConfirmPane({session, selectedIndex, canDelete, width}: {session?: SessionRecord; selectedIndex: number; canDelete: boolean; width: number}) {
	const options = canDelete ? ['Kill only, keep worktree', 'Kill and delete worktree', 'Cancel'] : ['Kill session', 'Cancel'];
	return (
		<Box flexDirection="column" width={width}>
			<Text bold>Kill session{session ? ` "${session.title}"` : ''}?</Text>
			{session?.worktree?.path ? <Text dimColor>{session.worktree.path}</Text> : null}
			{options.map((option, index) => (
				<Text key={option} inverse={index === selectedIndex}>
					{index === selectedIndex ? '›' : ' '} {option}
				</Text>
			))}
			<Text dimColor>enter choose • esc cancel • j/k move</Text>
		</Box>
	);
}

export function App({repoRoot, cwd, initialSidebarWidth, onSidebarWidthChange}: AppProps) {
	const {exit} = useApp();
	const [mode, setMode] = useState<Mode>('browse');
	const [sessions, setSessions] = useState<SessionRecord[]>([]);
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [programIndex, setProgramIndex] = useState(0);
	const [draftName, setDraftName] = useState('');
	const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>('none');
	const [worktrees, setWorktrees] = useState<WorktreeInfoRecord[]>([]);
	const [worktreeIndex, setWorktreeIndex] = useState(0);
	const [killConfirmIndex, setKillConfirmIndex] = useState(0);
	const [preview, setPreview] = useState<PreviewRecord>(EMPTY_PREVIEW);
	const [error, setError] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [client, setClient] = useState<LiveClient | undefined>();
	const [connectionEpoch, setConnectionEpoch] = useState(0);
	const [terminalSize, setTerminalSize] = useState<TerminalSize>(getTerminalSize());
	const [sidebarWidthOverride, setSidebarWidthOverride] = useState<number | undefined>(initialSidebarWidth);
	const [spinnerIndex, setSpinnerIndex] = useState(0);
	const selectedIdRef = useRef<string | undefined>(selectedId);

	useEffect(() => {
		selectedIdRef.current = selectedId;
	}, [selectedId]);

	useEffect(() => {
		const onResize = () => setTerminalSize(getTerminalSize());
		process.stdout.on('resize', onResize);
		return () => {
			process.stdout.off('resize', onResize);
		};
	}, []);

	const shouldAnimateStatus = sessions.some(
		session => session.status === 'starting' || (session.status === 'running' && session.agentStatus === 'active'),
	);

	useEffect(() => {
		if (!shouldAnimateStatus) {
			return;
		}
		const timer = setInterval(() => {
			setSpinnerIndex(index => (index + 1) % SPINNER_FRAMES.length);
		}, 120);
		return () => {
			clearInterval(timer);
		};
	}, [shouldAnimateStatus]);

	useEffect(() => {
		let cancelled = false;
		let reconnectScheduled = false;
		let reconnectTimer: NodeJS.Timeout | undefined;
		let currentClient: LiveClient | undefined;

		const scheduleReconnect = () => {
			if (cancelled || reconnectScheduled) {
				return;
			}
			reconnectScheduled = true;
			reconnectTimer = setTimeout(() => {
				setConnectionEpoch(value => value + 1);
			}, 500);
		};

		void (async () => {
			try {
				const nextClient = await createLiveClient({
					onSessionUpdated: session => {
						if (session.repoRoot !== repoRoot) {
							return;
						}
						setSessions(current => upsertSession(current, session));
					},
					onSessionRemoved: sessionId => {
						setSessions(current => current.filter(session => session.id !== sessionId));
						if (selectedIdRef.current === sessionId) {
							setPreview(EMPTY_PREVIEW);
						}
					},
					onPreviewUpdated: nextPreview => {
						if (nextPreview.sessionId && nextPreview.sessionId !== selectedIdRef.current) {
							return;
						}
						if (!nextPreview.sessionId && selectedIdRef.current) {
							return;
						}
						setPreview(nextPreview);
					},
					onError: nextError => {
						setError(nextError.message);
					},
					onClose: () => {
						setClient(undefined);
						scheduleReconnect();
					},
				});
				if (cancelled) {
					nextClient.close();
					return;
				}
				currentClient = nextClient;
				setClient(nextClient);
				const initialSessions = await nextClient.subscribe(repoRoot);
				if (cancelled) {
					nextClient.close();
					return;
				}
				setSessions(sortSessions(initialSessions));
				setError(undefined);
			} catch (nextError) {
				if (!cancelled) {
					setError(nextError instanceof Error ? nextError.message : String(nextError));
					scheduleReconnect();
				}
			}
		})();

		return () => {
			cancelled = true;
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
			if (currentClient) {
				currentClient.close();
			}
			setClient(current => (current === currentClient ? undefined : current));
		};
	}, [connectionEpoch, repoRoot]);

	useEffect(() => {
		setSelectedId(currentId => {
			if (sessions.length === 0) {
				return undefined;
			}
			if (currentId && sessions.some(session => session.id === currentId)) {
				return currentId;
			}
			return sessions[0]?.id;
		});
	}, [sessions]);

	const selectedIndex = useMemo(() => {
		if (!selectedId) {
			return 0;
		}
		const index = sessions.findIndex(session => session.id === selectedId);
		return index >= 0 ? index : 0;
	}, [selectedId, sessions]);

	const selectedSession = sessions[selectedIndex];
	const selectedCanDeleteWorktree = Boolean(
		selectedSession?.worktree?.path &&
		selectedSession.worktree.mode !== 'none' &&
		!selectedSession.worktree.isMain &&
		(!selectedSession.launchWorktreeRoot || selectedSession.worktree.path !== selectedSession.launchWorktreeRoot) &&
		!sessions.some(
			session =>
				session.id !== selectedSession.id &&
				session.status !== 'exited' &&
				session.worktree?.path === selectedSession.worktree?.path,
		),
	);

	useEffect(() => {
		if (!selectedSession) {
			setPreview(EMPTY_PREVIEW);
			return;
		}
		setPreview(current => {
			const sameSession = current.sessionId === selectedSession.id;
			const content =
				selectedSession.status === 'exited'
					? selectedSession.lastPreview ?? current.content
					: sameSession
						? current.content
						: '';
			return {
				sessionId: selectedSession.id,
				content,
				live: sameSession ? current.live : false,
				status: selectedSession.status,
				agentStatus: selectedSession.agentStatus,
			};
		});
	}, [selectedSession]);

	const spinnerFrame = SPINNER_FRAMES[spinnerIndex] ?? SPINNER_FRAMES[0]!;

	const layout = useMemo(() => {
		const totalWidth = terminalSize.cols;
		const totalHeight = terminalSize.rows;
		const leftWidth = clampSidebarWidth(sidebarWidthOverride ?? sidebarWidth(totalWidth), totalWidth);
		const separatorWidth = 3;
		const rightWidth = Math.max(20, totalWidth - leftWidth - separatorWidth);
		const footerLines = error ? 3 : 2;
		const contentHeight = Math.max(8, totalHeight - 2 - footerLines);
		const previewRows = Math.max(1, contentHeight - 2);
		return {
			sidebarWidth: leftWidth,
			previewWidth: rightWidth,
			contentHeight,
			previewCols: rightWidth,
			previewRows,
		};
	}, [error, sidebarWidthOverride, terminalSize.cols, terminalSize.rows]);

	const moveSelection = useCallback(
		(delta: number) => {
			if (sessions.length === 0) {
				return;
			}
			const nextIndex = (selectedIndex + delta + sessions.length) % sessions.length;
			setSelectedId(sessions[nextIndex]?.id);
		},
		[selectedIndex, sessions],
	);

	const resizeSidebar = useCallback(
		(delta: number) => {
			setSidebarWidthOverride(current => {
				const baseWidth = current ?? sidebarWidth(terminalSize.cols);
				const nextWidth = clampSidebarWidth(baseWidth + delta, terminalSize.cols);
				onSidebarWidthChange?.(nextWidth);
				return nextWidth;
			});
		},
		[onSidebarWidthChange, terminalSize.cols],
	);

	const refreshSessions = useCallback(async () => {
		if (!client) {
			throw new Error('still connecting to daemon');
		}
		const latest = await client.subscribe(repoRoot);
		setSessions(sortSessions(latest));
	}, [client, repoRoot]);

	useEffect(() => {
		if (!client) {
			return;
		}
		let cancelled = false;
		void client
			.watchPreview(selectedId, layout.previewCols, layout.previewRows)
			.then(nextPreview => {
				if (cancelled) {
					return;
				}
				if (nextPreview.sessionId && nextPreview.sessionId !== selectedId) {
					return;
				}
				setPreview(nextPreview);
			})
			.catch(nextError => {
				if (!cancelled) {
					setError(nextError instanceof Error ? nextError.message : String(nextError));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [client, layout.previewCols, layout.previewRows, selectedId]);

	const submitCreate = useCallback(async (existingWorktreePath?: string) => {
		const title = draftName.trim();
		if (!title) {
			setError('title cannot be empty');
			return;
		}
		if (!client) {
			setError('still connecting to daemon');
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const created = await client.createSession({
				title,
				program: PROGRAMS[programIndex]!.key,
				cwd,
				repoRoot,
				cols: layout.previewCols,
				rows: layout.previewRows,
				worktreeMode,
				existingWorktreePath,
			});
			setDraftName('');
			setWorktreeMode('none');
			setMode('browse');
			setSelectedId(created.id);
			setSessions(current => upsertSession(current, created));
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setBusy(false);
		}
	}, [client, cwd, draftName, layout.previewCols, layout.previewRows, programIndex, repoRoot, worktreeMode]);

	const killSelected = useCallback(async (deleteWorktree = false) => {
		if (!client || !selectedSession || selectedSession.status !== 'running') {
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await client.killSession(selectedSession.id, deleteWorktree);
			setMode('browse');
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setBusy(false);
		}
	}, [client, selectedSession]);

	const removeSelected = useCallback(async () => {
		if (!client || !selectedSession || selectedSession.status !== 'exited') {
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await client.removeSession(selectedSession.id);
			setPreview(EMPTY_PREVIEW);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setBusy(false);
		}
	}, [client, selectedSession]);

	useInput((input, key) => {
		if (busy) {
			return;
		}

		if (mode === 'browse') {
			if (input === 'q') {
				exit({kind: 'quit'} satisfies UiExitResult);
				return;
			}
			if (input === 'n') {
				setProgramIndex(0);
				setDraftName('');
				setWorktreeMode('none');
				setMode('pick-program');
				return;
			}
			if (input === 'r') {
				void refreshSessions().catch(nextError =>
					setError(nextError instanceof Error ? nextError.message : String(nextError)),
				);
				return;
			}
			if (key.upArrow || input === 'k') {
				moveSelection(-1);
				return;
			}
			if (key.downArrow || input === 'j') {
				moveSelection(1);
				return;
			}
			if (key.leftArrow || input === 'h') {
				resizeSidebar(-2);
				return;
			}
			if (key.rightArrow || input === 'l') {
				resizeSidebar(2);
				return;
			}
			if (input === 'x' && selectedSession?.status === 'running') {
				if (selectedSession.worktree?.path && selectedSession.worktree.mode !== 'none') {
					setKillConfirmIndex(0);
					setMode('confirm-kill');
				} else {
					void killSelected(false);
				}
				return;
			}
			if ((input === 'd' || key.delete) && selectedSession?.status === 'exited') {
				void removeSelected();
				return;
			}
			if (key.return && selectedSession?.status === 'running') {
				exit({kind: 'attach', sessionId: selectedSession.id} satisfies UiExitResult);
			}
			return;
		}

		if (mode === 'pick-program') {
			if (key.escape) {
				setMode('browse');
				return;
			}
			if (key.leftArrow || key.upArrow || input === 'k' || input === 'h') {
				setProgramIndex(index => (index - 1 + PROGRAMS.length) % PROGRAMS.length);
				return;
			}
			if (key.rightArrow || key.downArrow || input === 'j' || input === 'l') {
				setProgramIndex(index => (index + 1) % PROGRAMS.length);
				return;
			}
			if (key.return) {
				setMode('enter-name');
			}
			return;
		}

		if (mode === 'enter-name') {
			if (key.escape) {
				setMode('pick-program');
				return;
			}
			if (key.return) {
				if (worktreeMode === 'existing') {
					if (!client) {
						setError('still connecting to daemon');
						return;
					}
					setBusy(true);
					void client
						.listWorktrees(cwd)
						.then(items => {
							setWorktrees(items);
							setWorktreeIndex(0);
							setMode('pick-worktree');
						})
						.catch(nextError => setError(nextError instanceof Error ? nextError.message : String(nextError)))
						.finally(() => setBusy(false));
					return;
				}
				void submitCreate();
				return;
			}
			if (key.backspace || key.delete) {
				setDraftName(value => value.slice(0, -1));
				return;
			}
			if (key.tab) {
				setWorktreeMode(current => {
					const index = WORKTREE_MODES.findIndex(item => item.key === current);
					return WORKTREE_MODES[(index + 1) % WORKTREE_MODES.length]!.key;
				});
				return;
			}
			if (input) {
				setDraftName(value => value + input);
			}
			return;
		}

		if (mode === 'pick-worktree') {
			if (key.escape) {
				setMode('enter-name');
				return;
			}
			if (key.upArrow || input === 'k') {
				setWorktreeIndex(index => Math.max(0, index - 1));
				return;
			}
			if (key.downArrow || input === 'j') {
				setWorktreeIndex(index => Math.min(Math.max(0, worktrees.length - 1), index + 1));
				return;
			}
			if (key.return && worktrees[worktreeIndex]) {
				void submitCreate(worktrees[worktreeIndex]!.path);
				return;
			}
			return;
		}

		if (mode === 'confirm-kill') {
			const optionCount = selectedCanDeleteWorktree ? 3 : 2;
			if (key.escape) {
				setMode('browse');
				return;
			}
			if (key.upArrow || input === 'k') {
				setKillConfirmIndex(index => (index - 1 + optionCount) % optionCount);
				return;
			}
			if (key.downArrow || input === 'j') {
				setKillConfirmIndex(index => (index + 1) % optionCount);
				return;
			}
			if (key.return) {
				if (selectedCanDeleteWorktree) {
					if (killConfirmIndex === 0) void killSelected(false);
					else if (killConfirmIndex === 1) void killSelected(true);
					else setMode('browse');
				} else {
					if (killConfirmIndex === 0) void killSelected(false);
					else setMode('browse');
				}
				return;
			}
		}
	});

	return (
		<Box flexDirection="column">
			<Text color="cyan">deckhand</Text>
			<Text dimColor>
				repo: {repoRoot} • {describeConnection(client)}
			</Text>
			<Box flexDirection="row">
				<Sidebar
					sessions={sessions}
					selectedId={selectedSession?.id}
					width={layout.sidebarWidth}
					height={layout.contentHeight}
					spinnerFrame={spinnerFrame}
				/>
				<Text dimColor> │ </Text>
				{mode === 'browse' ? (
					<PreviewPane
						session={selectedSession}
						preview={preview}
						width={layout.previewWidth}
						height={layout.contentHeight}
						spinnerFrame={spinnerFrame}
					/>
				) : mode === 'pick-worktree' ? (
					<WorktreePickerPane worktrees={worktrees} selectedIndex={worktreeIndex} width={layout.previewWidth} />
				) : mode === 'confirm-kill' ? (
					<KillConfirmPane
						session={selectedSession}
						selectedIndex={killConfirmIndex}
						canDelete={selectedCanDeleteWorktree}
						width={layout.previewWidth}
					/>
				) : (
					<CreatePane
						mode={mode}
						programIndex={programIndex}
						draftName={draftName}
						worktreeMode={worktreeMode}
						width={layout.previewWidth}
					/>
				)}
			</Box>
			<Text dimColor>
				{mode === 'browse'
					? 'n new • enter attach • j/k move • h/l resize • x kill • d delete exited • r refresh • q quit'
					: 'esc cancel'}
			</Text>
			{busy ? <Text color="yellow">Working…</Text> : null}
			{error ? <Text color="red">Error: {error}</Text> : null}
		</Box>
	);
}
