import { describe, expect, it, vi } from "vitest";
import { computeAudioFadeMultiplier, scheduleAudioFadeGain } from "./audioRoutingEngine";

describe("computeAudioFadeMultiplier", () => {
	it("returns full volume when no fades are configured", () => {
		expect(computeAudioFadeMultiplier(0, 10000, 0, 0)).toBe(1);
		expect(computeAudioFadeMultiplier(5000, 10000, 0, 0)).toBe(1);
		expect(computeAudioFadeMultiplier(10000, 10000, 0, 0)).toBe(1);
	});

	it("ramps up linearly during the fade-in window", () => {
		expect(computeAudioFadeMultiplier(0, 10000, 2000, 0)).toBe(0);
		expect(computeAudioFadeMultiplier(1000, 10000, 2000, 0)).toBeCloseTo(0.5);
		expect(computeAudioFadeMultiplier(2000, 10000, 2000, 0)).toBe(1);
		expect(computeAudioFadeMultiplier(5000, 10000, 2000, 0)).toBe(1);
	});

	it("ramps down linearly during the fade-out window", () => {
		expect(computeAudioFadeMultiplier(5000, 10000, 0, 2000)).toBe(1);
		expect(computeAudioFadeMultiplier(8000, 10000, 0, 2000)).toBe(1);
		expect(computeAudioFadeMultiplier(9000, 10000, 0, 2000)).toBeCloseTo(0.5);
		expect(computeAudioFadeMultiplier(10000, 10000, 0, 2000)).toBe(0);
	});

	it("takes the lower of fade-in and fade-out when both windows overlap", () => {
		// A 3s clip with 2s fade-in and 2s fade-out overlaps in the middle;
		// the weaker (lower) multiplier should win at every point.
		expect(computeAudioFadeMultiplier(0, 3000, 2000, 2000)).toBe(0);
		expect(computeAudioFadeMultiplier(3000, 3000, 2000, 2000)).toBe(0);
		expect(computeAudioFadeMultiplier(1500, 3000, 2000, 2000)).toBeCloseTo(0.75);
	});

	it("clamps fade durations longer than the clip to the clip duration", () => {
		expect(computeAudioFadeMultiplier(0, 1000, 5000, 0)).toBe(0);
		expect(computeAudioFadeMultiplier(500, 1000, 5000, 0)).toBeCloseTo(0.5);
		expect(computeAudioFadeMultiplier(1000, 1000, 5000, 0)).toBe(1);
	});

	it("treats a non-positive duration as always full volume", () => {
		expect(computeAudioFadeMultiplier(0, 0, 1000, 1000)).toBe(1);
		expect(computeAudioFadeMultiplier(0, -5, 1000, 1000)).toBe(1);
	});
});

describe("scheduleAudioFadeGain", () => {
	function fakeGainParam() {
		const calls: Array<{ kind: "set" | "ramp"; value: number; time: number }> = [];
		return {
			calls,
			param: {
				setValueAtTime: vi.fn((value: number, time: number) => {
					calls.push({ kind: "set", value, time });
				}),
				linearRampToValueAtTime: vi.fn((value: number, time: number) => {
					calls.push({ kind: "ramp", value, time });
				}),
			},
		};
	}

	it("flattens to a constant when no fades are configured, matching the old static-gain behavior", () => {
		const { param, calls } = fakeGainParam();
		scheduleAudioFadeGain(param, 0, 0, 5000, 5000, 0, 0, 1);
		expect(calls).toEqual([
			{ kind: "set", value: 1, time: 0 },
			{ kind: "ramp", value: 1, time: 5 },
		]);
	});

	it("reconstructs fade-in, a full-volume plateau, and fade-out even when the whole clip is one chunk", () => {
		// This is the regression this test guards: a clip entirely inside a
		// single render chunk must not collapse into a flat ramp between its
		// start and end gain (both 0 here), which would render as silence.
		const { param, calls } = fakeGainParam();
		scheduleAudioFadeGain(param, 0, 0, 5000, 5000, 1000, 1000, 1);
		expect(calls).toEqual([
			{ kind: "set", value: 0, time: 0 },
			{ kind: "ramp", value: 1, time: 1 },
			{ kind: "ramp", value: 1, time: 4 },
			{ kind: "ramp", value: 0, time: 5 },
		]);
	});

	it("schedules only the breakpoints that fall within a later chunk's slice", () => {
		// Same clip as above, but this call only covers the chunk-local slice
		// from elapsed 3000ms-5000ms (e.g. chunk 2 of a multi-chunk export):
		// the fade-in breakpoint (1000ms) is out of range and dropped, but the
		// fade-out-start breakpoint (4000ms) falls inside this slice.
		const { param, calls } = fakeGainParam();
		scheduleAudioFadeGain(param, 0, 3000, 5000, 5000, 1000, 1000, 1);
		expect(calls).toEqual([
			{ kind: "set", value: 1, time: 0 },
			{ kind: "ramp", value: 1, time: 1 },
			{ kind: "ramp", value: 0, time: 2 },
		]);
	});
});
