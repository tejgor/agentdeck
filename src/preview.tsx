import React from 'react';
import {Box, Text} from 'ink';
import type {PreviewRecord, SessionRecord} from './types.js';

interface PreviewPaneProps {
	session?: SessionRecord;
	preview: PreviewRecord;
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

function fallbackMessage(session: SessionRecord | undefined, preview: PreviewRecord): string {
	if (!session) {
		return 'No sessions yet. Press n to create one.';
	}
	if (session.status === 'starting') {
		return 'Starting session…';
	}
	if (session.status === 'exited') {
		return preview.content || 'Session exited.';
	}
	return preview.content || 'Waiting for agent output…';
}

export function PreviewPane({session, preview, width, height}: PreviewPaneProps) {
	const header = session
		? `${session.title} [${session.program}] · ${preview.live ? 'live preview' : session.status}`
		: 'Preview';
	const subheader = session ? session.cwd : 'Select a session from the sidebar.';
	const bodyHeight = Math.max(1, height - 2);
	const content = fallbackMessage(session, preview);
	const lines = fitLines(content, width, bodyHeight);

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Text bold>{truncate(header, width)}</Text>
			<Text dimColor>{truncate(subheader, width)}</Text>
			{lines.map((line, index) => (
				<Text key={`preview-line-${index}`}>{line}</Text>
			))}
		</Box>
	);
}
