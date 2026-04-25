import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

export async function findRepoRoot(cwd = process.cwd()): Promise<string> {
	const {stdout} = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
	return stdout.trim();
}

export async function ensureGitRepo(cwd = process.cwd()): Promise<string> {
	try {
		return await findRepoRoot(cwd);
	} catch {
		throw new Error('deckhand must be run from inside a git repository');
	}
}
