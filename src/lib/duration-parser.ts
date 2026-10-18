export function parseDuration(duration: string): number {
	const trimmed = duration.trim().toLowerCase();
	const match = trimmed.match(/^(\d+)\s*([mhdw])$/);

	if (!match) {
		throw new Error(
			`Invalid duration format: "${duration}". Expected format: <number><unit> (e.g., 1h, 2d, 1w)`,
		);
	}

	const value = parseInt(match[1]!, 10);
	const unit = match[2]!;

	const msPerMinute = 60 * 1000;
	const msPerHour = msPerMinute * 60;
	const msPerDay = msPerHour * 24;
	const msPerWeek = msPerDay * 7;

	const factors: Record<string, number> = {
		m: msPerMinute,
		h: msPerHour,
		d: msPerDay,
		w: msPerWeek,
	};
	const result = value * factors[unit]!;
	if (!Number.isSafeInteger(result))
		throw new Error(`Duration is too large: "${duration}"`);
	return result;
}

export function parseDurationToSeconds(duration: string): number {
	return Math.floor(parseDuration(duration) / 1000);
}
