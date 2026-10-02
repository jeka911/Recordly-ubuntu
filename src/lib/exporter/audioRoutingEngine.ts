import type { AudioRegion } from "@/components/video-editor/types";
import { SOURCE_AUDIO_NORMALIZE_GAIN } from "@/components/video-editor/audio/audioTypes";
import { resolveSourceAudioFallbackPaths } from "./sourceAudioFallback";

export type SourceTrackId = "mic" | "system" | "mixed";
export type ResolvedAudioTrackKind = "user" | "system" | "mic" | "mixed" | "embedded";

export interface ResolvedAudioTrack {
	id: string;
	kind: ResolvedAudioTrackKind;
	sourceRef: {
		path: string;
		startDelayMs: number;
	};
	gain: number;
	timelineBinding: {
		startMs: number;
		endMs: number;
	};
	/** Linear fade-in duration in milliseconds, from the start of the binding. */
	fadeInMs: number;
	/** Linear fade-out duration in milliseconds, ending at the end of the binding. */
	fadeOutMs: number;
}

/**
 * Gain multiplier (0-1) for a linear fade-in/fade-out envelope at a given
 * offset into a track's timeline binding. Shared by the live preview
 * (continuous per-frame volume) and the offline exporter (scheduled gain
 * ramps per rendered chunk) so both apply the exact same fade curve.
 */
export function computeAudioFadeMultiplier(
	elapsedMs: number,
	durationMs: number,
	fadeInMs: number,
	fadeOutMs: number,
): number {
	if (!Number.isFinite(durationMs) || durationMs <= 0) {
		return 1;
	}

	const clampedFadeIn = Math.max(0, Math.min(fadeInMs, durationMs));
	const clampedFadeOut = Math.max(0, Math.min(fadeOutMs, durationMs));

	let multiplier = 1;
	if (clampedFadeIn > 0 && elapsedMs < clampedFadeIn) {
		multiplier = Math.min(multiplier, Math.max(0, elapsedMs) / clampedFadeIn);
	}

	const fadeOutStartMs = durationMs - clampedFadeOut;
	if (clampedFadeOut > 0 && elapsedMs > fadeOutStartMs) {
		const remainingMs = durationMs - elapsedMs;
		multiplier = Math.min(multiplier, Math.max(0, remainingMs) / clampedFadeOut);
	}

	return Math.max(0, Math.min(1, multiplier));
}

/**
 * Minimal subset of AudioParam used by scheduleAudioFadeGain, so it can be
 * driven by a real AudioParam or a lightweight test double.
 */
export interface SchedulableGainParam {
	setValueAtTime(value: number, startTime: number): unknown;
	linearRampToValueAtTime(value: number, endTime: number): unknown;
}

/**
 * Schedules a gain AudioParam so a (possibly chunked) slice of a track's
 * fade envelope plays back correctly. A chunk slice can span the *entire*
 * fade-in, a flat plateau, and the *entire* fade-out at once (e.g. a short
 * clip rendered in a single chunk) -- a naive two-point ramp from the gain
 * at the slice's start straight to the gain at its end would flatten that
 * into one straight line, which is silent start-to-end whenever both
 * endpoints happen to be 0. Scheduling every envelope "knee" that falls
 * inside the slice (where the fade-in ends and/or the fade-out begins)
 * reconstructs the actual piecewise-linear curve instead.
 */
export function scheduleAudioFadeGain(
	gainParam: SchedulableGainParam,
	chunkTimeOffsetSec: number,
	elapsedStartMs: number,
	elapsedEndMs: number,
	durationMs: number,
	fadeInMs: number,
	fadeOutMs: number,
	baseGain: number,
): void {
	const breakpointsMs = new Set<number>([elapsedStartMs, elapsedEndMs]);
	if (fadeInMs > elapsedStartMs && fadeInMs < elapsedEndMs) {
		breakpointsMs.add(fadeInMs);
	}
	const fadeOutStartMs = durationMs - fadeOutMs;
	if (fadeOutStartMs > elapsedStartMs && fadeOutStartMs < elapsedEndMs) {
		breakpointsMs.add(fadeOutStartMs);
	}

	const sortedMs = Array.from(breakpointsMs).sort((a, b) => a - b);
	sortedMs.forEach((ms, index) => {
		const timeSec = chunkTimeOffsetSec + (ms - elapsedStartMs) / 1000;
		const gain = baseGain * computeAudioFadeMultiplier(ms, durationMs, fadeInMs, fadeOutMs);
		if (index === 0) {
			gainParam.setValueAtTime(gain, timeSec);
		} else {
			gainParam.linearRampToValueAtTime(gain, timeSec);
		}
	});
}

export interface ResolvedAudioPlan {
	hasEmbeddedSourceAudio: boolean;
	pathsByTrack: Partial<Record<SourceTrackId, string>>;
	playbackPaths: string[];
	muteEmbeddedPreview: boolean;
	includeEmbeddedInExport: boolean;
	tracks: ResolvedAudioTrack[];
	masterGain: number;
}

export function getSourceTrackIdFromPath(audioPath: string): SourceTrackId {
	const normalized = audioPath.toLowerCase();
	if (normalized.includes(".mic.")) return "mic";
	if (normalized.includes(".system.")) return "system";
	return "mixed";
}

function clampGain(value: number, max: number) {
	if (!Number.isFinite(value)) return 1;
	return Math.max(0, Math.min(max, value));
}

export function buildResolvedAudioPlan(input: {
	videoResource: string | null | undefined;
	sourceAudioFallbackPaths: string[] | null | undefined;
	audioRegions?: AudioRegion[];
	sourceTrackGainById?: Partial<Record<SourceTrackId, number>>;
	embeddedGain?: number;
	masterGain?: number;
}): ResolvedAudioPlan {
	const { hasEmbeddedSourceAudio, externalAudioPaths } = resolveSourceAudioFallbackPaths(
		input.videoResource,
		input.sourceAudioFallbackPaths,
	);

	const pathsByTrack: Partial<Record<SourceTrackId, string>> = {};
	for (const path of externalAudioPaths) {
		const trackId = getSourceTrackIdFromPath(path);
		if (!pathsByTrack[trackId]) {
			pathsByTrack[trackId] = path;
		}
	}

	const hasDedicatedTracks = Boolean(pathsByTrack.system || pathsByTrack.mic);
	const playbackPaths: string[] = [];
	if (pathsByTrack.system) playbackPaths.push(pathsByTrack.system);
	if (pathsByTrack.mic) playbackPaths.push(pathsByTrack.mic);
	if (!hasDedicatedTracks && pathsByTrack.mixed) playbackPaths.push(pathsByTrack.mixed);

	const includeEmbeddedInExport = !pathsByTrack.system && !pathsByTrack.mixed;
	const resolvedRegions = (input.audioRegions ?? [])
		.slice()
		.sort((a, b) => a.startMs - b.startMs);
	const tracks: ResolvedAudioTrack[] = resolvedRegions.map((region) => ({
		id: `user:${region.id}`,
		kind: "user",
		sourceRef: {
			path: region.audioPath,
			startDelayMs: 0,
		},
		gain: clampGain(region.volume * (region.normalize ? SOURCE_AUDIO_NORMALIZE_GAIN : 1), 1),
		timelineBinding: {
			startMs: Math.max(0, region.startMs),
			endMs: Math.max(0, region.endMs),
		},
		fadeInMs: Math.max(0, region.fadeInMs ?? 0),
		fadeOutMs: Math.max(0, region.fadeOutMs ?? 0),
	}));

	for (const audioPath of playbackPaths) {
		const trackId = getSourceTrackIdFromPath(audioPath);
		tracks.push({
			id: `${trackId}:${audioPath}`,
			kind: trackId,
			sourceRef: {
				path: audioPath,
				startDelayMs: 0,
			},
			gain: clampGain(input.sourceTrackGainById?.[trackId] ?? 1, 2),
			timelineBinding: {
				startMs: 0,
				endMs: Number.POSITIVE_INFINITY,
			},
			fadeInMs: 0,
			fadeOutMs: 0,
		});
	}

	if (hasEmbeddedSourceAudio && input.videoResource) {
		tracks.push({
			id: `embedded:${input.videoResource}`,
			kind: "embedded",
			sourceRef: {
				path: input.videoResource,
				startDelayMs: 0,
			},
			gain: clampGain(input.embeddedGain ?? input.sourceTrackGainById?.mixed ?? 1, 2),
			timelineBinding: {
				startMs: 0,
				endMs: Number.POSITIVE_INFINITY,
			},
			fadeInMs: 0,
			fadeOutMs: 0,
		});
	}

	return {
		hasEmbeddedSourceAudio,
		pathsByTrack,
		playbackPaths,
		muteEmbeddedPreview: hasDedicatedTracks && !includeEmbeddedInExport,
		includeEmbeddedInExport,
		tracks,
		masterGain: clampGain(input.masterGain ?? 1, 1),
	};
}
