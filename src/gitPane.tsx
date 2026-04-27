import React from 'react';
import {Box, Text} from 'ink';
import type {GitRecord, SessionRecord} from './types.js';

interface GitPaneProps {
	session?: SessionRecord;
	git: GitRecord;
	width: number;
	height: number;
}

function truncate(text: string, width: number): string {
	if (width <= 0) {
		return '';
	}
	if (text.length <= width) {
		return text;
	}
	if (width === 1) {
		return text.slice(0, 1);
	}
	return `${text.slice(0, width - 1)}…`;
}

function fitLines(text: string, width: number, height: number): string[] {
	const rawLines = text.length > 0 ? text.split('\n') : [''];
	const lines = rawLines.map(line => truncate(line, width));
	if (lines.length >= height) {
		return lines.slice(0, height);
	}
	return [...lines, ...Array.from({length: height - lines.length}, () => '')];
}

function fallbackMessage(session: SessionRecord | undefined, git: GitRecord): string {
	if (!session) {
		return 'No session selected.';
	}
	if (session.status === 'exited') {
		return 'Session exited. Restart it to open lazygit.';
	}
	if (!git.live && git.content) {
		return git.content;
	}
	if (!git.live && git.sessionId === session.id) {
		return 'lazygit exited. Switch away and back after restarting it.';
	}
	return git.content || 'Starting lazygit…';
}

export function GitPane({session, git, width, height}: GitPaneProps) {
	const header = session ? `Git — ${session.title}${git.live ? ' ●' : ' ○'}` : 'Git';
	const subheader = git.cwd ?? session?.cwd ?? 'Select a session from the sidebar.';
	const bodyHeight = Math.max(1, height - 2);
	const lines = fitLines(fallbackMessage(session, git), width, bodyHeight);

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Text bold>{truncate(header, width)}</Text>
			<Text dimColor>{truncate(subheader, width)}</Text>
			{lines.map((line, index) => (
				<Text key={`git-line-${index}`}>{line}</Text>
			))}
		</Box>
	);
}
