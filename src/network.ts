import os from 'node:os';

function firstLanIPv4(): string | undefined {
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === 'IPv4' && !address.internal) {
				return address.address;
			}
		}
	}
	return undefined;
}

function formatUrlHost(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function remoteHostForUrl(host: string): string {
	if (host === '0.0.0.0' || host === '::') {
		return firstLanIPv4() ?? os.hostname();
	}
	return formatUrlHost(host);
}

export function remoteHttpUrl(host: string, port: number, path = ''): string {
	return `http://${remoteHostForUrl(host)}:${port}${path}`;
}
