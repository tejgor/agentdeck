import React from 'react';
import {Box, Text} from 'ink';
import type {SessionRecord} from './types.js';

interface SidebarProps {
	sessions: SessionRecord[];
	selectedId?: string;
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

function statusGlyph(status: SessionRecord['status']): string {
	switch (status) {
		case 'running':
			return '●';
		case 'starting':
			return '◌';
		case 'exited':
			return '○';
	}
}

function statusColor(status: SessionRecord['status']): 'green' | 'yellow' | 'gray' {
	switch (status) {
		case 'running':
			return 'green';
		case 'starting':
			return 'yellow';
		case 'exited':
			return 'gray';
	}
}

function visibleSessions(sessions: SessionRecord[], selectedIndex: number, availableRows: number): SessionRecord[] {
	if (availableRows <= 0 || sessions.length <= availableRows) {
		return sessions;
	}

	const half = Math.floor(availableRows / 2);
	let start = Math.max(0, selectedIndex - half);
	const maxStart = Math.max(0, sessions.length - availableRows);
	if (start > maxStart) {
		start = maxStart;
	}
	return sessions.slice(start, start + availableRows);
}

export function Sidebar({sessions, selectedId, width, height}: SidebarProps) {
	const selectedIndex = Math.max(0, sessions.findIndex(session => session.id === selectedId));
	const rowsForSessions = Math.max(1, height - 2);
	const visible = visibleSessions(sessions, selectedIndex, rowsForSessions);
	const visibleStart = Math.max(0, sessions.indexOf(visible[0] ?? sessions[0]));

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Text bold>{truncate('Instances', width)}</Text>
			{sessions.length === 0 ? (
				<Text dimColor>{truncate('No sessions yet.', width)}</Text>
			) : (
				visible.map((session, index) => {
					const actualIndex = visibleStart + index;
					const active = session.id === selectedId;
					const label = `${active ? '›' : ' '} ${actualIndex + 1}. ${session.title} [${session.program}]`;
					return (
						<Text key={session.id} inverse={active} color={statusColor(session.status)}>
							{truncate(`${statusGlyph(session.status)} ${label}`, width)}
						</Text>
					);
				})
			)}
		</Box>
	);
}
