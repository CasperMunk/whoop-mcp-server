import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from '../src/types.js';

// Week of 11 to 18 Oct 2026, Copenhagen summer time (+02:00).
// Strain, recovery, HRV, sleep durations and workout start times match what the
// tools reported for that week. Exact sleep onset and wake times are synthetic,
// chosen so the old DATE(start_time) labels reproduce the observed bug
// (two rows for Wed 14, Mon 12 and Fri 16 missing). Cycle 100 (Sun 11) is
// outside the observed window; its strain and recovery are invented.

const OFFSET = '+02:00';
const USER = 1;
const MIN = 60_000;

interface Night {
	cycleId: number;
	sleepOnset: string; // UTC
	inBedMin: number;
	awakeMin: number;
	strain: number;
	recovery: number;
	hrv: number;
	day: string; // expected local label, as in the Whoop app
}

export const nights: Night[] = [
	{ cycleId: 100, sleepOnset: '2026-10-10T23:15:00.000Z', inBedMin: 435, awakeMin: 20, strain: 13.1, recovery: 60, hrv: 58.0, day: '2026-10-11' },
	{ cycleId: 101, sleepOnset: '2026-10-11T22:40:00.000Z', inBedMin: 260, awakeMin: 17, strain: 7.7, recovery: 35, hrv: 52.4, day: '2026-10-12' },
	{ cycleId: 102, sleepOnset: '2026-10-13T00:30:00.000Z', inBedMin: 390, awakeMin: 21, strain: 10.4, recovery: 36, hrv: 47.6, day: '2026-10-13' },
	{ cycleId: 103, sleepOnset: '2026-10-14T01:00:00.000Z', inBedMin: 260, awakeMin: 16, strain: 1.5, recovery: 11, hrv: 28.5, day: '2026-10-14' },
	{ cycleId: 104, sleepOnset: '2026-10-14T20:30:00.000Z', inBedMin: 550, awakeMin: 22, strain: 10.6, recovery: 92, hrv: 91.5, day: '2026-10-15' },
	{ cycleId: 105, sleepOnset: '2026-10-15T21:00:00.000Z', inBedMin: 510, awakeMin: 20, strain: 1.3, recovery: 75, hrv: 67.5, day: '2026-10-16' },
	{ cycleId: 106, sleepOnset: '2026-10-17T00:30:00.000Z', inBedMin: 420, awakeMin: 17, strain: 3.2, recovery: 76, hrv: 71.7, day: '2026-10-17' },
	{ cycleId: 107, sleepOnset: '2026-10-18T01:00:00.000Z', inBedMin: 340, awakeMin: 21, strain: 0.2, recovery: 53, hrv: 60.4, day: '2026-10-18' },
];

const addMin = (iso: string, min: number): string => new Date(Date.parse(iso) + min * MIN).toISOString();

export function buildFixture(opts: { withOffsets: boolean; withSleepCycleId: boolean }) {
	const tz = opts.withOffsets ? OFFSET : (undefined as unknown as string);

	const cycles: WhoopCycle[] = nights.map((n, i) => ({
		id: n.cycleId,
		user_id: USER,
		start: n.sleepOnset,
		end: nights[i + 1]?.sleepOnset ?? null, // last cycle is in progress
		timezone_offset: tz,
		score_state: 'SCORED',
		score: { strain: n.strain, kilojoule: 8000, average_heart_rate: 60, max_heart_rate: 150 },
	}));

	const sleeps: WhoopSleep[] = nights.map(n => ({
		id: `sleep-${n.cycleId}`,
		cycle_id: opts.withSleepCycleId ? n.cycleId : undefined,
		user_id: USER,
		created_at: addMin(n.sleepOnset, n.inBedMin + 5),
		updated_at: addMin(n.sleepOnset, n.inBedMin + 5),
		start: n.sleepOnset,
		end: addMin(n.sleepOnset, n.inBedMin),
		timezone_offset: tz,
		nap: false,
		score_state: 'SCORED',
		score: {
			stage_summary: {
				total_in_bed_time_milli: n.inBedMin * MIN,
				total_awake_time_milli: n.awakeMin * MIN,
				total_no_data_time_milli: 0,
				total_light_sleep_time_milli: 0,
				total_slow_wave_sleep_time_milli: 0,
				total_rem_sleep_time_milli: 0,
				sleep_cycle_count: 4,
				disturbance_count: 5,
			},
			sleep_needed: {
				baseline_milli: 8 * 60 * MIN,
				need_from_sleep_debt_milli: 0,
				need_from_recent_strain_milli: 0,
				need_from_recent_nap_milli: 0,
			},
			respiratory_rate: 15,
			sleep_performance_percentage: 80,
			sleep_consistency_percentage: 70,
			sleep_efficiency_percentage: 90,
		},
	}));

	const recoveries: WhoopRecovery[] = nights.map(n => ({
		cycle_id: n.cycleId,
		sleep_id: `sleep-${n.cycleId}`,
		user_id: USER,
		created_at: addMin(n.sleepOnset, n.inBedMin + 10),
		updated_at: addMin(n.sleepOnset, n.inBedMin + 10),
		score_state: 'SCORED',
		score: {
			user_calibrating: false,
			recovery_score: n.recovery,
			resting_heart_rate: 55,
			hrv_rmssd_milli: n.hrv,
		},
	}));

	const workout = (id: string, sport: string, startUtc: string, durMin: number, strain: number): WhoopWorkout => ({
		id,
		user_id: USER,
		created_at: addMin(startUtc, durMin + 20),
		updated_at: addMin(startUtc, durMin + 20),
		start: startUtc,
		end: addMin(startUtc, durMin),
		timezone_offset: OFFSET,
		sport_id: 1,
		sport_name: sport,
		score_state: 'SCORED',
		score: { strain, average_heart_rate: 110, max_heart_rate: 160, kilojoule: 2000, percent_recorded: 1 },
	});

	const workouts: WhoopWorkout[] = [
		workout('w-volleyball', 'volleyball', '2026-10-11T11:11:00.000Z', 145, 10.98), // Sun 11 13:11 local
		workout('w-fitness', 'functional-fitness', '2026-10-12T10:36:00.000Z', 23, 6.52), // Mon 12 12:36 local
		workout('w-activity', 'activity', '2026-10-15T15:38:00.000Z', 98, 10.47), // Thu 15 17:38 local
	];

	return { cycles, sleeps, recoveries, workouts };
}
