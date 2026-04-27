import React from 'react';
import {Box, Text} from 'ink';
import type {SessionRecord, TerminalRecord} from './types.js';

interface TerminalPaneProps {
	session?: SessionRecord;
	terminal: TerminalRecord;
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

function fallbackMessage(session: SessionRecord | undefined, terminal: TerminalRecord): string {
	if (!session) {
		return 'No session selected.';
	}
	if (session.status === 'exited') {
		return 'Session exited. Restart it to open a terminal.';
	}
	if (!terminal.live && terminal.content) {
		return terminal.content;
	}
	if (!terminal.live && terminal.sessionId === session.id) {
		return 'Terminal exited. Switch away and back after restarting the session.';
	}
	return terminal.content || 'Starting terminal…';
}

export function TerminalPane({session, terminal, width, height}: TerminalPaneProps) {
	const header = session ? `Terminal — ${session.title}${terminal.live ? ' ●' : ' ○'}` : 'Terminal';
	const subheader = terminal.cwd ?? session?.cwd ?? 'Select a session from the sidebar.';
	const bodyHeight = Math.max(1, height - 2);
	const lines = fitLines(fallbackMessage(session, terminal), width, bodyHeight);

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Text bold>{truncate(header, width)}</Text>
			<Text dimColor>{truncate(subheader, width)}</Text>
			{lines.map((line, index) => (
				<Text key={`terminal-line-${index}`}>{line}</Text>
			))}
		</Box>
	);
}
