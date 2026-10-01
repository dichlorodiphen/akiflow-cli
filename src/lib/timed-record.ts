/** Small source-neutral projection for timed event detectors. */
export interface TimedRecord {
	id: string;
	calendar: string;
	title: string | null;
	/** UTC instant; null excludes all-day records. */
	start: string | null;
	end: string | null;
}
