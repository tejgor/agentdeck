import React from 'react';
import {Box, Text} from 'ink';
import type {GitRecord, SessionRecord} from './types.js';
import {THEME, compactPath, fitLines, truncate} from './ui.js';

interface GitPaneProps {
	session?: SessionRecord;
	git: GitRecord;
	width: number;
	height: number;
}

function fallbackMessage(session: SessionRecord | undefined, git: GitRecord): string {
	if (!session) return 'No session selected.';
	if (session.status === 'exited') return 'Session exited. Restart it to open lazygit.';
	if (!git.live && git.content) return git.content;
	if (!git.live && git.sessionId === session.id) return 'lazygit exited. Switch away and back after restarting it.';
	return git.content || 'Starting lazygit…';
}

export function GitPane({session, git, width, height}: GitPaneProps) {
	const bodyHeight = Math.max(1, height - 1);
	const lines = fitLines(fallbackMessage(session, git), width, bodyHeight);
	const status = git.live ? '● live' : '○ cold';
	const pathSource = git.cwd ?? session?.worktree?.path ?? session?.cwd ?? 'Select a session from the sidebar.';
	const cwdBudget = Math.max(8, width - status.length - 1);
	const cwd = compactPath(pathSource, cwdBudget);

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Box justifyContent="space-between" width={width}>
				<Text color={THEME.muted}>{truncate(cwd, cwdBudget)}</Text>
				<Text color={git.live ? THEME.success : THEME.muted}>{status}</Text>
			</Box>
			{lines.map((line, index) => <Text key={`git-line-${index}`}>{line}</Text>)}
		</Box>
	);
}
