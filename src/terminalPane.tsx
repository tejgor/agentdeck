import React from 'react';
import {Box, Text} from 'ink';
import type {SessionRecord, TerminalRecord} from './types.js';
import {THEME, compactPath, fitLines, truncate} from './ui.js';

interface TerminalPaneProps {
	session?: SessionRecord;
	terminal: TerminalRecord;
	width: number;
	height: number;
}

function fallbackMessage(session: SessionRecord | undefined, terminal: TerminalRecord): string {
	if (!session) return 'No session selected.';
	if (session.status === 'exited') return 'Session exited. Restart it to open a terminal.';
	if (!terminal.live && terminal.content) return terminal.content;
	if (!terminal.live && terminal.sessionId === session.id) return 'Terminal exited. Switch away and back after restarting the session.';
	return terminal.content || 'Starting terminal…';
}

export function TerminalPane({session, terminal, width, height}: TerminalPaneProps) {
	const bodyHeight = Math.max(1, height - 1);
	const lines = fitLines(fallbackMessage(session, terminal), width, bodyHeight);
	const status = terminal.live ? '● live' : '○ cold';
	const pathSource = terminal.cwd ?? session?.worktree?.path ?? session?.cwd ?? 'Select a session from the sidebar.';
	const cwdBudget = Math.max(8, width - status.length - 1);
	const cwd = compactPath(pathSource, cwdBudget);

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Box justifyContent="space-between" width={width}>
				<Text color={THEME.muted}>{truncate(cwd, cwdBudget)}</Text>
				<Text color={terminal.live ? THEME.success : THEME.muted}>{status}</Text>
			</Box>
			{lines.map((line, index) => <Text key={`terminal-line-${index}`}>{line}</Text>)}
		</Box>
	);
}
